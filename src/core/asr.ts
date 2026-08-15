/**
 * SpeechRecognizer —— 语音识别(deep module)。
 *
 * 接口(调用者需知的全部事实):
 * - start() 开始识别(权限/引擎初始化可能异步失败 → reject);
 * - stop() 停止并定稿;
 * - onText/onError 注册回调(返回退订函数);
 *   onText(delta, final):final=false 为当前部分识别文本(累计式回显);
 *   final=true 为本轮累计定稿全文(替换式)——两个 adapter 语义统一,
 *   调用方直接覆盖 pendingText 即可,无需区分引擎;
 * - 同一实例一次只服务一轮识别;新一轮重新 start。
 *
 * seam:两个 client 侧 adapter 填同一接口 ——
 * - WebSpeechRecognizer(浏览器 SpeechRecognition,零依赖);
 * - RpcRecognizer(浏览器采麦 → /voice.asr 通道 → host 原生识别)。
 * host 侧 OnnxModel/OnnxSession 不填此接口:结果经 feed() 返回值交付
 * (见 core/native-asr.ts),一份数据只走一条通道。
 */
import { Emitter } from './emitter.js'

export interface SpeechRecognizer {
  start(): Promise<void>
  stop(): void
  onText(cb: (delta: string, final: boolean) => void): () => void
  onError(cb: (err: Error) => void): () => void
}

/** 支持收尾冲刷的识别器(RpcRecognizer 的调用面;测试替身同形)。 */
export type FlushableRecognizer = SpeechRecognizer & {
  pushChunk(audio: string, final: boolean): Promise<void>
}

/** 浏览器 Web Speech API 识别(V0.5,零原生依赖,在线)。 */
export class WebSpeechRecognizer implements SpeechRecognizer {
  private recognition: SpeechRecognition | null = null
  private readonly text = new Emitter<[delta: string, final: boolean]>()
  private readonly errors = new Emitter<[err: Error]>()

  constructor(private readonly lang = 'zh-CN') {}

  start(): Promise<void> {
    const Ctor = (globalThis as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
      ?? (globalThis as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
    if (Ctor === undefined) {
      return Promise.reject(new Error('浏览器不支持 SpeechRecognition(可降级键盘输入)'))
    }
    const recognition = new Ctor()
    recognition.lang = this.lang
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // 只取最新一条:interim 会随事件更新替换,避免重复累积
      const last = event.results[event.results.length - 1]
      if (last === undefined) return
      const transcript = last[0]?.transcript ?? ''
      if (transcript !== '') this.text.emit(transcript, last.isFinal)
    }
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.errors.emit(new Error(event.error))
    }
    recognition.onend = () => {
      // 非主动停止时兜底定稿:已通过 onresult 的 isFinal 通知
    }
    this.recognition = recognition
    recognition.start()
    return Promise.resolve()
  }

  stop(): void {
    this.recognition?.stop()
    this.recognition = null
  }

  onText(cb: (delta: string, final: boolean) => void): () => void {
    return this.text.on(cb)
  }

  onError(cb: (err: Error) => void): () => void {
    return this.errors.on(cb)
  }
}

/** host /voice.asr 的调用面(client 半注入,不依赖 connection 包类型)。 */
export interface AsrRpc {
  callAsr(payload: { sessionId: string; audio: string; final: boolean }): Promise<{ delta: string; final: boolean }>
}

/**
 * 远程识别:浏览器采麦 → base64 PCM 分块 → host 原生 ASR → 增量文本回传。
 * (V2 的 client 半;采麦与编码由调用方提供,便于单测。)
 * final 交付"本轮累计定稿全文":host 的 VAD 每段独立定稿回传,
 * 这里内部累计成替换式全文,与 WebSpeechRecognizer 语义对齐。
 */
export class RpcRecognizer implements SpeechRecognizer {
  private readonly text = new Emitter<[delta: string, final: boolean]>()
  private readonly errors = new Emitter<[err: Error]>()
  private stopped = false
  /** 本轮累计定稿文本(start() 重置) */
  private finalizedText = ''

  constructor(
    private readonly rpc: AsrRpc,
    private readonly sessionId: string,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    this.finalizedText = ''
    // 实际采麦循环由调用方驱动(pushChunk),这里只重置状态
  }

  /** 推入一段已编码 PCM(调用方在麦克风回调里逐段调用)。 */
  async pushChunk(audio: string, final: boolean): Promise<void> {
    if (this.stopped) return
    try {
      const res = await this.rpc.callAsr({ sessionId: this.sessionId, audio, final })
      if (res.delta === '') return
      if (res.final) {
        this.finalizedText += res.delta
        this.text.emit(this.finalizedText, true)
      } else {
        this.text.emit(res.delta, false)
      }
    } catch (err) {
      this.errors.emit(err instanceof Error ? err : new Error(String(err)))
    }
  }

  stop(): void {
    this.stopped = true
  }

  onText(cb: (delta: string, final: boolean) => void): () => void {
    return this.text.on(cb)
  }

  onError(cb: (err: Error) => void): () => void {
    return this.errors.on(cb)
  }
}
