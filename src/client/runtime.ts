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
 * 定稿语义统一:onText(final=true) 交付"本轮累计定稿全文"(替换式)——WebSpeech 的
 * 累积 transcript 与 Rpc 的 VAD 分段差异各自关在 adapter 实现里;stopMic 持有
 * 轮次守卫,停麦后迟到的识别回调一律作废,杜绝浏览器停麦双提交竞态。
 * 单麦克风语义:全局同时只有一轮识别;别的会话点停/快捷键会停掉当前轮,
 * 文本仍提交给开启本轮的那个会话(activeSession)。
 * 实现:引擎探测(host /voice.ping → native 否则 browser)、麦克风采集
 * (ScriptProcessor PCM 16kHz→base64 分块)、识别→提交(conversation 服务)。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RpcRecognizer, WebSpeechRecognizer, type FlushableRecognizer, type SpeechRecognizer } from '../core/asr'
import { Emitter } from '../core/emitter'
import type { AsrChunkPayload, AsrChunkResponse, VoiceEngine, VoicePingResponse } from '../types'

export interface VoiceRuntimeConfig {
  /** 'auto' = ping host 探测;'browser'/'native' 强制 */
  engine: VoiceEngine
}

/** 麦克风采集句柄(stop 幂等)。 */
interface MicCapture {
  stop(): void
}

/** 测试/替换 seam(默认即生产实现;外部 interface 不受影响)。 */
export interface VoiceRuntimeDeps {
  /** 按引擎构造识别器(默认:WebSpeechRecognizer / RpcRecognizer) */
  createRecognizer?: (engine: VoiceEngine, sessionId: string) => SpeechRecognizer
  /** 开始采麦,每块 Int16 回调一次(默认:navigator 采麦 + ScriptProcessor) */
  capture?: (onChunk: (int16: Int16Array) => void) => Promise<MicCapture>
  /** 提交定稿文本(默认:conversation 服务,与打字同路) */
  submit?: (sessionId: string, text: string) => Promise<void>
  /** 浏览器停麦等待 final onresult 的超时(默认 500ms;测试可调小) */
  finalizeTimeoutMs?: number
}

interface ResolvedDeps {
  createRecognizer: ((engine: VoiceEngine, sessionId: string) => SpeechRecognizer) | null
  capture: (onChunk: (int16: Int16Array) => void) => Promise<MicCapture>
  submit: (sessionId: string, text: string) => Promise<void>
  finalizeTimeoutMs: number
}

export class VoiceRuntime {
  private engine: VoiceEngine | null = null
  private listening = false
  private recognizer: SpeechRecognizer | null = null
  private capture: MicCapture | null = null
  /** 本轮累计定稿文本(停麦时提交;onText(final) 替换式更新) */
  private pendingText = ''
  /** 当前部分识别文本(边说边出字,未定稿) */
  private partialText = ''
  /** 本轮已收到 final 定稿(浏览器停麦等待用) */
  private finalized = false
  /** 轮次守卫:停麦后作废迟到的识别回调,杜绝双提交 */
  private round = 0
  /** 开启本轮识别的会话;停麦提交一律归它(跨会话点停不串台) */
  private activeSession: string | null = null
  /** 浏览器停麦等待 final 的 resolve */
  private browserFinalResolve: (() => void) | null = null
  private readonly listeners = new Emitter<[]>()
  private readonly deps: ResolvedDeps

  constructor(
    private readonly ctx: ClientContext,
    private readonly config: VoiceRuntimeConfig,
    deps: VoiceRuntimeDeps = {},
  ) {
    this.deps = {
      createRecognizer: deps.createRecognizer ?? null,
      capture: deps.capture ?? capturePcm,
      submit: deps.submit ?? ((sessionId, text) => this.submitText(sessionId, text)),
      finalizeTimeoutMs: deps.finalizeTimeoutMs ?? 500,
    }
  }

  /** 解析引擎:强制配置直接采用;auto 经 /voice.ping 探测 host 原生能力。 */
  async getEngine(): Promise<VoiceEngine> {
    if (this.engine !== null) return this.engine
    if (this.config.engine !== 'auto') {
      this.engine = this.config.engine
      return this.engine
    }
    try {
      const res = await this.ctx.connection.rpc.call('/voice', 'ping', {})
      const ping = res.ok ? res.value as VoicePingResponse : undefined
      this.engine = ping?.native === true ? 'native' : 'browser'
    } catch {
      this.engine = 'browser' // host 不在 → 降级浏览器引擎
    }
    return this.engine
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
    this.finalized = false
    this.pendingText = ''
    this.partialText = ''
    this.notify()
    const engine = await this.getEngine()
    if (this.round !== round) return // 探测期间被 stop 打断
    const rec = this.deps.createRecognizer !== null
      ? this.deps.createRecognizer(engine, sessionId)
      : engine === 'browser'
        ? new WebSpeechRecognizer()
        : new RpcRecognizer(
          { callAsr: (payload) => this.callAsr(payload) },
          sessionId,
        )
    // 定稿语义统一:final=true 交付本轮累计定稿全文(替换式)
    rec.onText((text, final) => {
      if (this.round !== round) return
      if (final) {
        this.pendingText = text
        this.partialText = ''
        this.finalized = true
        this.browserFinalResolve?.()
        this.browserFinalResolve = null
        this.notify()
        // Web Speech 说完即止(continuous=false):final 到达自动停麦提交
        if (engine === 'browser') void this.stopMic(sessionId)
      } else {
        this.partialText = text
        this.notify()
      }
    })
    rec.onError((err) => {
      if (this.round !== round) return
      if (engine === 'browser') {
        this.pendingText = ''
        void this.stopMic(sessionId).then(() => { console.error('dsh-voice ASR:', err) })
      } else {
        // 单块失败不报废本轮:后续分块继续(native 侧 host 亦如此处理)
        console.error('dsh-voice ASR:', err)
      }
    })
    this.recognizer = rec
    try {
      if (engine !== 'browser') {
        // native:采麦 → 分块 → host ASR → 累积文本
        const capture = await this.deps.capture((int16) => {
          void (rec as FlushableRecognizer).pushChunk(encodeBase64(int16), false)
        })
        if (this.round !== round) {
          capture.stop() // 等待采麦期间被 stop 打断
          return
        }
        this.capture = capture
      }
      await rec.start()
      if (this.round !== round) {
        this.capture?.stop()
        this.capture = null
        return
      }
    } catch (err) {
      if (this.round === round) {
        this.round += 1
        this.capture?.stop()
        this.capture = null
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
    if (this.engine === 'native') {
      // 关键:发 final=true 空块,让 host 补静音冲刷 VAD 弹出最后一段
      try {
        await (rec as FlushableRecognizer).pushChunk('', true)
      } catch (err) {
        console.error('dsh-voice ASR 收尾失败:', err)
      }
      rec.stop()
    } else if (!this.finalized && (this.partialText !== '' || this.pendingText !== '')) {
      // 手动停麦:等 Web Speech 的异步 final onresult 交付定稿全文(超时兜底提交 partial)
      const finalPromise = new Promise<void>((resolve) => { this.browserFinalResolve = resolve })
      rec.stop()
      await Promise.race([finalPromise, delay(this.deps.finalizeTimeoutMs)])
    } else {
      rec.stop()
    }
    this.round += 1 // 作废所有迟到回调(防双提交)
    this.browserFinalResolve = null
    this.capture?.stop()
    this.capture = null
    this.recognizer = null
    this.activeSession = null
    const text = (this.pendingText + this.partialText).trim()
    this.pendingText = ''
    this.partialText = ''
    this.finalized = false
    this.listening = false
    this.notify()
    if (text !== '') await this.deps.submit(target, text)
  }

  /** 当前部分识别文本(按钮提示实时回显用)。 */
  getPartial(): string {
    return this.partialText
  }

  private async callAsr(payload: AsrChunkPayload): Promise<AsrChunkResponse> {
    const res = await this.ctx.connection.rpc.call('/voice', 'asr', payload)
    if (!res.ok) throw new Error(res.error.message)
    return res.value as AsrChunkResponse
  }

  private async submitText(sessionId: string, text: string): Promise<void> {
    const scope = this.ctx.sessions.scope(sessionId)
    if (scope === undefined) return
    const conversation = scope.get<ConversationService>('conversation')
    if (conversation === undefined) return
    conversation.send(text)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 采集麦克风 PCM(Int16 16kHz 单声道)。
 * MicCapture seam 由两个 adapter 支撑:生产(ScriptProcessor)+ 测试替身
 * (VoiceRuntimeDeps.capture 注入)——两 adapter 即成真 seam。 */
async function capturePcm(onChunk: (int16: Int16Array) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const actx = new AudioContext({ sampleRate: 16000 })
  // 部分浏览器忽略采样率请求:按实际率线性重采样到 16k,保证 host 端 VAD/ASR 输入正确
  const contextRate = actx.sampleRate
  const source = actx.createMediaStreamSource(stream)
  const processor = actx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const resampled = contextRate === 16000
      ? input
      : linearResample(input, contextRate, 16000)
    onChunk(floatToInt16(resampled))
  }
  source.connect(processor)
  processor.connect(actx.destination)
  return {
    stop(): void {
      try {
        processor.disconnect()
        source.disconnect()
        void actx.close()
      } catch {
        // 幂等
      }
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

/** Float32 → Int16(限幅)。 */
function floatToInt16(input: Float32Array): Int16Array {
  const int16 = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

/** 线性插值重采样(仅当浏览器实际采样率 ≠ 16k 时使用)。 */
function linearResample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = toRate / fromRate
  const outLen = Math.round(input.length * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i += 1) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = src - i0
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac
  }
  return out
}

/** Int16 PCM → base64(分片避开 String.fromCharCode 栈限制)。 */
function encodeBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
