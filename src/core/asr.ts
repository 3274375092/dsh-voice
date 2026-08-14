/**
 * SpeechRecognizer —— 语音识别(deep module)。
 *
 * 接口(调用者需知的全部事实):
 * - start() 开始识别(权限/引擎初始化可能异步失败 → reject);
 * - stop() 停止并定稿;
 * - onText/onError 注册回调(返回退订函数);onText(delta, final) 流式增量 + 定稿标记;
 * - 同一实例一次只服务一轮识别;新一轮重新 start。
 *
 * seam:三个 adapter 填同一接口 ——
 * - WebSpeechRecognizer(浏览器 SpeechRecognition,零依赖);
 * - RpcRecognizer(浏览器采麦 → /voice.asr 通道 → host 原生识别);
 * - NativeOnnxRecognizer(host 侧 sherpa-onnx-node,由研究结论补充实现)。
 */

export interface SpeechRecognizer {
  start(): Promise<void>
  stop(): void
  onText(cb: (delta: string, final: boolean) => void): () => void
  onError(cb: (err: Error) => void): () => void
}

/** 浏览器 Web Speech API 识别(V0.5,零原生依赖,在线)。 */
export class WebSpeechRecognizer implements SpeechRecognizer {
  private recognition: SpeechRecognition | null = null
  private readonly textCbs = new Set<(delta: string, final: boolean) => void>()
  private readonly errorCbs = new Set<(err: Error) => void>()

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
      if (transcript !== '') for (const cb of this.textCbs) cb(transcript, last.isFinal)
    }
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      for (const cb of this.errorCbs) cb(new Error(event.error))
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
    this.textCbs.add(cb)
    return () => { this.textCbs.delete(cb) }
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorCbs.add(cb)
    return () => { this.errorCbs.delete(cb) }
  }
}

/** host /voice.asr 的调用面(client 半注入,不依赖 connection 包类型)。 */
export interface AsrRpc {
  callAsr(payload: { sessionId: string; audio: string; final: boolean }): Promise<{ delta: string; final: boolean }>
}

/**
 * 远程识别:浏览器采麦 → base64 PCM 分块 → host 原生 ASR → 增量文本回传。
 * (V2 的 client 半;采麦与编码由调用方提供,便于单测。)
 */
export class RpcRecognizer implements SpeechRecognizer {
  private readonly textCbs = new Set<(delta: string, final: boolean) => void>()
  private readonly errorCbs = new Set<(err: Error) => void>()
  private stopped = false

  constructor(
    private readonly rpc: AsrRpc,
    private readonly sessionId: string,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    // 实际采麦循环由调用方驱动(pushChunk),这里只重置状态
  }

  /** 推入一段已编码 PCM(调用方在麦克风回调里逐段调用)。 */
  async pushChunk(audio: string, final: boolean): Promise<void> {
    if (this.stopped) return
    try {
      const res = await this.rpc.callAsr({ sessionId: this.sessionId, audio, final })
      if (res.delta !== '') for (const cb of this.textCbs) cb(res.delta, res.final)
    } catch (err) {
      for (const cb of this.errorCbs) cb(err instanceof Error ? err : new Error(String(err)))
    }
  }

  stop(): void {
    this.stopped = true
  }

  onText(cb: (delta: string, final: boolean) => void): () => void {
    this.textCbs.add(cb)
    return () => { this.textCbs.delete(cb) }
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorCbs.add(cb)
    return () => { this.errorCbs.delete(cb) }
  }
}
