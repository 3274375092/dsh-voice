/**
 * SpeechRecognizer —— 语音识别(deep module)。
 *
 * 接口(调用者需知的全部事实):
 * - start() 开始识别;适配器自持采声,权限/引擎初始化失败会 reject;
 * - stop() 停止并定稿:resolve 时定稿已交付完毕,resolve 后保证不再有任何回调;
 * - onText(cb):final=false 为当前部分识别文本(累计式回显);
 *   final=true 为本轮累计定稿全文(替换式)——两个 adapter 语义统一,
 *   调用方直接覆盖 pendingText 即可,无需区分引擎;
 * - onError(cb):仅致命错误(轮次应终止);可吸收的失败(如单块 RPC 错误)
 *   由 adapter 内部消化,不打扰调用方;
 * - onEnd(cb):轮次自然结束(识别器自判说完,如 Web Speech 说完即止);
 *   原生引擎永不发出——它只能由用户点停;
 * - 同一实例一次只服务一轮识别;新一轮重新 start。
 *
 * seam:两个 client 侧 adapter 填同一接口 ——
 * - WebSpeechRecognizer(浏览器 SpeechRecognition,自持采声,零依赖);
 * - NativeRecognizer(浏览器采声 → /voice.asr 通道 → host 原生识别)。
 * host 侧 OnnxModel/OnnxSession 不填此接口:结果经 feed() 返回值交付
 * (见 core/native-asr.ts),一份数据只走一条通道。
 */
import { Emitter } from '../core/emitter.js'
import { capturePcm, encodeBase64, type MicCapture } from './audio.js'
import type { AsrChunkPayload, AsrChunkResponse, ResolvedEngine } from '../types.js'

export interface SpeechRecognizer {
  start(): Promise<void>
  stop(): Promise<void>
  onText(cb: (text: string, final: boolean) => void): () => void
  onError(cb: (err: Error) => void): () => void
  onEnd(cb: () => void): () => void
}

/** 按引擎构造识别器(默认工厂;engine 值到适配器的唯一映射)。 */
export function createRecognizer(
  engine: ResolvedEngine,
  sessionId: string,
  callAsr: (payload: AsrChunkPayload) => Promise<AsrChunkResponse>,
): SpeechRecognizer {
  if (engine === 'native') return new NativeRecognizer({ sessionId, callAsr })
  return new WebSpeechRecognizer()
}

/** 浏览器 Web Speech API 识别(V0.5,零原生依赖,在线)。 */
export class WebSpeechRecognizer implements SpeechRecognizer {
  private recognition: SpeechRecognition | null = null
  private readonly text = new Emitter<[delta: string, final: boolean]>()
  private readonly errors = new Emitter<[err: Error]>()
  private readonly ends = new Emitter<[]>()
  /** 已收到定稿(final 到达即置位;停麦时无需再等) */
  private finalized = false
  /** 是否收到过任何文本(无文本时停麦无需等待) */
  private gotText = false
  /** 最近一次停止是否由用户发起(区分自然结束) */
  private userStopped = false
  private stopPromise: Promise<void> | null = null
  private finalWaiter: (() => void) | null = null

  constructor(
    private readonly lang = 'zh-CN',
    private readonly finalizeTimeoutMs = 500,
  ) {}

  async start(): Promise<void> {
    const Ctor = (globalThis as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition
      ?? (globalThis as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition
    if (Ctor === undefined) {
      throw new Error('浏览器不支持 SpeechRecognition(可降级键盘输入)')
    }
    this.finalized = false
    this.gotText = false
    this.userStopped = false
    this.stopPromise = null
    this.finalWaiter = null
    const recognition = new Ctor()
    recognition.lang = this.lang
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // 只取最新一条:interim 会随事件更新替换,避免重复累积
      const last = event.results[event.results.length - 1]
      if (last === undefined) return
      const transcript = last[0]?.transcript ?? ''
      if (transcript === '') return
      this.gotText = true
      if (last.isFinal) {
        this.finalized = true
        this.finalWaiter?.()
        this.finalWaiter = null
      }
      this.text.emit(transcript, last.isFinal)
    }
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.errors.emit(new Error(event.error))
    }
    recognition.onend = () => {
      // 自然结束(非用户点停):识别器自判说完,通知调用方结束轮次
      if (!this.userStopped) this.ends.emit()
    }
    this.recognition = recognition
    recognition.start()
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    this.userStopped = true
    this.recognition?.stop()
    this.recognition = null
    this.stopPromise = new Promise<void>((resolve) => {
      if (this.finalized || !this.gotText) {
        resolve() // 已定稿或没有任何文本:无需等待
        return
      }
      // 手动停麦:stop() 会触发一次异步 final onresult,等它交付定稿;
      // 超时兜底(提交 partial 由调用方决定)。
      const timer = setTimeout(() => {
        this.finalWaiter = null
        resolve()
      }, this.finalizeTimeoutMs)
      this.finalWaiter = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    return this.stopPromise
  }

  onText(cb: (delta: string, final: boolean) => void): () => void {
    return this.text.on(cb)
  }

  onError(cb: (err: Error) => void): () => void {
    return this.errors.on(cb)
  }

  onEnd(cb: () => void): () => void {
    return this.ends.on(cb)
  }
}

export interface NativeRecognizerOptions {
  sessionId: string
  callAsr: (payload: AsrChunkPayload) => Promise<AsrChunkResponse>
  /** 采声(默认 navigator 采麦 + ScriptProcessor;测试注入替身) */
  capture?: (onChunk: (int16: Int16Array) => void) => Promise<MicCapture>
}

/**
 * 原生识别:浏览器采声 → base64 PCM 分块 → host 原生 ASR → 增量文本回传。
 * 自持采声,内部完成 采声→编码→分块推送 全链路;调用方只负责开始/停止。
 * 分块经内部 promise 链串行化,不依赖平台 RPC 对并发调用的保序。
 * 单块 RPC 失败在内部吸收(记日志继续),不打断本轮;
 * 只有采声失败会在 start() 时 reject。
 * final 交付"本轮累计定稿全文":host 的 VAD 每段独立定稿回传,
 * 这里内部累计成替换式全文,与 WebSpeechRecognizer 语义对齐。
 */
export class NativeRecognizer implements SpeechRecognizer {
  private readonly text = new Emitter<[delta: string, final: boolean]>()
  private readonly errors = new Emitter<[err: Error]>()
  private readonly ends = new Emitter<[]>()
  /** 串行推送链:前一块 dispatch 完成后才发下一块 */
  private queue: Promise<void> = Promise.resolve()
  private capture: MicCapture | null = null
  private stopped = true
  private stopPromise: Promise<void> | null = null
  /** 本轮累计定稿文本(start() 重置) */
  private finalizedText = ''

  constructor(private readonly options: NativeRecognizerOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    this.stopPromise = null
    this.finalizedText = ''
    const capture = await (this.options.capture ?? capturePcm)((int16) => this.onChunk(int16))
    if (this.stopped) {
      capture.stop() // start 期间被 stop 打断:立即释放采声
      return
    }
    this.capture = capture
  }

  private onChunk(int16: Int16Array): void {
    if (this.stopped) return
    this.enqueue(encodeBase64(int16), false)
  }

  private enqueue(audio: string, final: boolean): void {
    this.queue = this.queue.then(() => this.dispatch(audio, final))
  }

  private async dispatch(audio: string, final: boolean): Promise<void> {
    try {
      const res = await this.options.callAsr({ sessionId: this.options.sessionId, audio, final })
      if (res.delta === '') return
      if (res.final) {
        this.finalizedText += res.delta
        this.text.emit(this.finalizedText, true)
      } else {
        this.text.emit(res.delta, false)
      }
    } catch (err) {
      // 单块失败不报废本轮:后续分块继续(host 侧亦如此处理)
      console.error('dsh-voice ASR:', err instanceof Error ? err.message : String(err))
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise
    this.stopped = true
    this.capture?.stop()
    this.capture = null
    // 关键:发 final=true 空块,让 host 补静音冲刷 VAD 弹出最后一段;
    // 挂在推送链尾,resolve 时定稿已交付完毕。
    this.enqueue('', true)
    this.stopPromise = this.queue
    return this.stopPromise
  }

  onText(cb: (delta: string, final: boolean) => void): () => void {
    return this.text.on(cb)
  }

  onError(cb: (err: Error) => void): () => void {
    return this.errors.on(cb)
  }

  onEnd(cb: () => void): () => void {
    return this.ends.on(cb)
  }
}
