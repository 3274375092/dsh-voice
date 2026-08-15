/**
 * VoiceRuntime —— 客户端语音运行时(deep module)。
 *
 * 接口(MicButton / 快捷键只碰这几个方法):
 * - getEngine(): 解析后的引擎(browser | native);
 * - isListening() / subscribe(cb): 监听状态与变更通知(供 useSyncExternalStore);
 * - toggleMic(sessionId): 开关一轮识别;
 * - stopMic(sessionId): 停止并提交(幂等,双引擎一致);
 * - getPartial(): 当前部分识别文本(实时回显)。
 *
 * 定稿语义统一:onText(final=true) 交付"本轮累计定稿全文"(替换式);
 * 采声、停麦竞速、自然结束等引擎差异全部关在 adapter 实现里(见 asr.ts),
 * runtime 只按统一契约编排:onEnd → 停麦提交;onError → 终止并丢弃文本。
 * SpeechRecognizer.stop() 契约:resolve 时定稿已交付完毕、resolve 后不再有
 * 任何回调 —— 停麦双提交竞态在结构上不存在,轮次守卫只防"启动期间被打断"。
 * 单麦克风语义:全局同时只有一轮识别;别的会话点停/快捷键会停掉当前轮,
 * 文本仍提交给开启本轮的那个会话(activeSession)。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createRecognizer, type SpeechRecognizer } from './asr.js'
import { createVoiceService, type VoiceService } from './voice-service.js'
import { Emitter } from '../core/emitter.js'
import type { ResolvedEngine, VoiceEngine } from '../types.js'

export interface VoiceRuntimeConfig {
  /** 'auto' = ping host 探测;'browser'/'native' 强制 */
  engine: VoiceEngine
}

/** 测试/替换 seam(默认即生产实现;外部 interface 不受影响)。 */
export interface VoiceRuntimeDeps {
  /** 按引擎构造识别器(默认:createRecognizer,适配器自持采声) */
  createRecognizer?: (engine: ResolvedEngine, sessionId: string) => SpeechRecognizer
  /** 提交定稿文本(默认:conversation 服务,与打字同路) */
  submit?: (sessionId: string, text: string) => Promise<void>
  /** /voice 通道调用面(默认:从 ctx.connection.rpc 构建;测试注入替身) */
  rpc?: VoiceService
}

export class VoiceRuntime {
  private engine: ResolvedEngine | null = null
  private listening = false
  private recognizer: SpeechRecognizer | null = null
  /** 本轮累计定稿文本(停麦时提交;onText(final) 替换式更新) */
  private pendingText = ''
  /** 当前部分识别文本(边说边出字,未定稿) */
  private partialText = ''
  /** 轮次守卫:启动被打断、停麦后作废一切迟到回调 */
  private round = 0
  /** 停止进行中:onEnd/onError 与用户点停并发时防重入 */
  private stopping = false
  /** 开启本轮识别的会话;停麦提交一律归它(跨会话点停不串台) */
  private activeSession: string | null = null
  private readonly listeners = new Emitter<[]>()
  private readonly deps: {
    createRecognizer: (engine: ResolvedEngine, sessionId: string) => SpeechRecognizer
    submit: (sessionId: string, text: string) => Promise<void>
    rpc: VoiceService
  }

  constructor(
    private readonly ctx: ClientContext,
    private config: VoiceRuntimeConfig,
    deps: VoiceRuntimeDeps = {},
  ) {
    const rpc = deps.rpc ?? createVoiceService((channel, endpoint, payload) =>
      this.ctx.connection.rpc.call(channel, endpoint, payload))
    this.deps = {
      createRecognizer: deps.createRecognizer ?? ((engine, sessionId) =>
        createRecognizer(engine, sessionId, (payload) => rpc.asr(payload))),
      submit: deps.submit ?? ((sessionId, text) => this.submitText(sessionId, text)),
      rpc,
    }
  }

  /** 解析引擎:强制配置直接采用;auto 经 /voice.ping 取 host 下发的生效引擎。 */
  async getEngine(): Promise<ResolvedEngine> {
    if (this.engine !== null) return this.engine
    if (this.config.engine !== 'auto') {
      this.engine = this.config.engine
      return this.engine
    }
    try {
      this.engine = (await this.deps.rpc.ping()).engine
    } catch {
      this.engine = 'browser' // host 不在/决策失败 → 降级浏览器引擎
    }
    return this.engine
  }

  /**
   * host /voice.config 到达后更新引擎选择。空闲时立即失效解析缓存,
   * 下一轮从新配置开始;正在识别的一轮不打断。
   */
  setEngine(engine: VoiceEngine): void {
    if (this.config.engine === engine) return
    this.config = { ...this.config, engine }
    if (!this.listening) this.engine = null
  }

  isListening(): boolean {
    return this.listening
  }

  subscribe(cb: () => void): () => void {
    return this.listeners.on(cb)
  }

  private notify(): void {
    this.listeners.emit()
  }

  /** 开关一轮识别。resolve 表示状态已切换(识别结果在后续回调提交)。 */
  async toggleMic(sessionId: string): Promise<void> {
    if (this.listening) {
      await this.stopMic(this.activeSession ?? sessionId)
      return
    }
    const round = ++this.round
    this.activeSession = sessionId
    this.listening = true
    this.pendingText = ''
    this.partialText = ''
    this.notify()
    const engine = await this.getEngine()
    if (this.round !== round) return // 探测期间被 stop 打断
    const rec = this.deps.createRecognizer(engine, sessionId)
    // 定稿语义统一:final=true 交付本轮累计定稿全文(替换式)
    rec.onText((text, final) => {
      if (this.round !== round) return
      if (final) {
        this.pendingText = text
        this.partialText = ''
      } else {
        this.partialText = text
      }
      this.notify()
    })
    rec.onError((err) => {
      if (this.round !== round) return
      // 统一策略:终止本轮并丢弃文本(native 可吸收的块级失败已在 adapter 内消化)
      this.pendingText = ''
      this.partialText = ''
      void this.stopMic(sessionId).then(() => { console.error('dsh-voice ASR:', err) })
    })
    rec.onEnd(() => {
      if (this.round !== round) return
      void this.stopMic(sessionId)
    })
    this.recognizer = rec
    try {
      await rec.start()
      if (this.round !== round) {
        void rec.stop() // 启动期间被打断:释放 adapter 内部资源(采声)
        return
      }
    } catch (err) {
      if (this.round === round) {
        this.round += 1
        this.recognizer = null
        this.activeSession = null
        this.listening = false
        this.notify()
      }
      throw err
    }
  }

  /** 停止识别;定稿文本非空则作为一条用户消息提交。幂等;轮次守卫杜绝迟到回调。 */
  async stopMic(sessionId: string): Promise<void> {
    const rec = this.recognizer
    if (rec === null) {
      // 未开始或启动中(引擎探测):作废进行中的启动
      this.round += 1
      this.activeSession = null
      this.listening = false
      this.notify()
      return
    }
    const target = this.activeSession ?? sessionId
    if (this.stopping) return // 防重入:并发进来的停止直接返回,在途的负责收尾
    this.stopping = true
    try {
      await rec.stop() // 契约:resolve 后不再有任何回调
    } catch (err) {
      console.error('dsh-voice ASR 收尾失败:', err)
    }
    this.round += 1 // 作废一切迟到回调
    this.stopping = false
    this.recognizer = null
    this.activeSession = null
    const text = (this.pendingText + this.partialText).trim()
    this.pendingText = ''
    this.partialText = ''
    this.listening = false
    // 下一轮重新按当前 config 解析引擎:host /voice.config 即使在上一轮
    // 识别过程中到达,也会从下一轮开始生效。
    this.engine = null
    this.notify()
    if (text !== '') await this.deps.submit(target, text)
  }

  /** 当前部分识别文本(按钮提示实时回显用)。 */
  getPartial(): string {
    return this.partialText
  }

  private async submitText(sessionId: string, text: string): Promise<void> {
    const scope = this.ctx.sessions.scope(sessionId)
    if (scope === undefined) return
    const conversation = scope.get<ConversationService>('conversation')
    if (conversation === undefined) return
    conversation.send(text)
  }
}
