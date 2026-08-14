/**
 * OnnxModel / OnnxSession —— 原生流式 ASR(sherpa-onnx-node:zipformer2 + silero VAD)。
 *
 * 模型与识别状态分层:
 * - OnnxModel:权重(OnlineRecognizer)只加载一份,host 全局共享(内存大户);
 * - OnnxSession:每个 sessionId 独立一份 VAD / live partial 流 / 尾音缓冲,
 *   并发会话互不串音;模型未加载时 openSession() 返回 null。
 *
 * 接口(host 半专用,不填 client 的 SpeechRecognizer seam):
 * - model.start() 懒加载模型(缺包/缺模型 → reject);
 * - session.feed(int16, final) → { partial, finals }:喂一段 Int16 PCM(16kHz 单声道),
 *   partial 为当前语音的实时部分识别文本(累计),finals 为本次弹出的定稿句。
 *   结果只经返回值交付——一份数据一条通道,无双通道回传。
 * VAD 收尾需要静音冲刷:final=true 时补 0.8s 静音再取尾段。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** ESM 产物下的 CJS 动态加载入口 */
const require = createRequire(import.meta.url)

/** 原生 ASR 模型选项(host 的 Config 直接 extend 此形状,单一来源,避免逐字段透传) */
export interface AsrModelOptions {
  /** 模型根目录的绝对路径 */
  modelDir: string
  /** ASR 模型子目录: asr-zh(纯中文)| asr-zh-en-2025(中英双语,均 zipformer2) */
  asrDir?: string
  /** VAD 静音阈值(0-1;对齐 voxelf 默认 0.3) */
  vadThreshold?: number
  /** 判定一句话说完的尾部静音秒数(对齐 voxelf 默认 0.5) */
  minSilenceSeconds?: number
  /** 尾音补偿时长(秒):VAD 段弹出后追加段后的音频再识别,
   * 补偿渐弱尾音被 VAD 截断(voxelf 的 vad_tail_pad,默认 0.6) */
  tailPadSeconds?: number
}

interface OnlineRecognizerLike {
  createStream(): OnlineStreamLike
  isReady(stream: unknown): boolean
  decode(stream: unknown): void
  getResult(stream: unknown): { text: string }
}
interface OnlineStreamLike {
  acceptWaveform(chunk: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}

interface VadLike {
  acceptWaveform(samples: Float32Array): void
  isDetected(): boolean
  isEmpty(): boolean
  front(): { samples: Float32Array }
  pop(): void
  flush(): void
}

interface OnnxModuleLike {
  OnlineRecognizer: new (config: unknown) => OnlineRecognizerLike
  Vad: new (config: unknown, windowSize: number) => VadLike
}

/** silero VAD 配置(每个会话独立一个 VAD 实例;模型共享)。 */
function vadConfig(options: AsrModelOptions): unknown {
  return {
    sileroVad: {
      model: join(options.modelDir, 'vad', 'silero_vad.onnx'),
      threshold: options.vadThreshold ?? 0.3,
      minSpeechDuration: 0.25,
      minSilenceDuration: options.minSilenceSeconds ?? 0.5,
      windowSize: 512,
      maxSpeechDuration: 20,
    },
    sampleRate: 16000,
    numThreads: 1,
  }
}

/** 共享的模型权重:加载一次,供任意会话 openSession。 */
export class OnnxModel {
  private onnx: OnnxModuleLike | null = null
  private recognizer: OnlineRecognizerLike | null = null
  private loadFailed = false

  constructor(private readonly options: AsrModelOptions) {}

  private load(): void {
    if (this.recognizer !== null || this.loadFailed) return
    const dir = this.options.modelDir
    const asrDir = this.options.asrDir ?? 'asr-zh'
    const onnx = require('sherpa-onnx-node') as OnnxModuleLike
    this.recognizer = new onnx.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(dir, asrDir, 'encoder.int8.onnx'),
          decoder: join(dir, asrDir, 'decoder.onnx'),
          joiner: join(dir, asrDir, 'joiner.int8.onnx'),
        },
        tokens: join(dir, asrDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        modelType: 'zipformer2',
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: false,
    })
    this.onnx = onnx
  }

  async start(): Promise<void> {
    try {
      this.load()
    } catch (err) {
      this.loadFailed = true
      throw err instanceof Error ? err : new Error(String(err))
    }
    if (this.recognizer === null) throw new Error('ASR 模型不可用')
  }

  /** 打开一个识别会话(权重共享,VAD/流状态独立);模型未加载返回 null。 */
  openSession(): OnnxSession | null {
    if (this.recognizer === null || this.onnx === null) return null
    return new OnnxSession(this.recognizer, this.onnx, this.options)
  }
}

/** 一次识别会话的独立状态:VAD + live partial 流 + 尾音缓冲。 */
export class OnnxSession {
  private readonly vad: VadLike
  /** 滚动尾音缓冲:保存最近 tailPadSeconds 的音频,段弹出时追加进识别输入
   * (voxelf tail_buf 机制,补偿渐弱尾音被 VAD 截断) */
  private readonly tailBuf: Float32Array[] = []
  private tailLen = 0
  /** 当前语音的 live 识别流(边说边出字;VAD 弹出定稿段时 inputFinished) */
  private liveStream: OnlineStreamLike | null = null

  constructor(
    private readonly recognizer: OnlineRecognizerLike,
    onnx: OnnxModuleLike,
    private readonly options: AsrModelOptions,
  ) {
    this.vad = new onnx.Vad(vadConfig(options), 30)
  }

  /** 喂入一段 Int16 PCM。
   * partial = 当前语音的实时部分识别文本(边说边出字,累计);
   * finals = 本段弹出的定稿句(VAD 判定一句话结束)。
   * final=true 时补静音冲刷尾段;空块(final 收尾)绝不喂给 VAD
   * (native 层对 0 长度 samples 会报 nullptr)。 */
  feed(int16: Int16Array, final: boolean): { partial: string; finals: string[] } {
    let partial = ''
    if (int16.length > 0) {
      const samples = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i += 1) samples[i] = (int16[i] ?? 0) / 32768
      this.vad.acceptWaveform(samples)
      this.pushTail(samples)
      // 实时部分识别:语音期间把每块喂进 live stream 并解码取当前文本
      // (partial 仅供边说边看,定稿由 VAD 段解码负责,故不做 onset 预滚)
      if (this.liveStream === null && this.vad.isDetected()) {
        this.liveStream = this.recognizer.createStream()
      }
      if (this.liveStream !== null) {
        this.liveStream.acceptWaveform({ sampleRate: 16000, samples })
        while (this.recognizer.isReady(this.liveStream)) this.recognizer.decode(this.liveStream)
        partial = this.recognizer.getResult(this.liveStream).text
      }
    }
    if (final) {
      // 补 0.8s 静音冲刷尾段(VAD 需要静音才弹出最后一句),再 flush 兜底
      const silence = new Float32Array(Math.round(16000 * 0.8))
      this.vad.acceptWaveform(silence)
      this.pushTail(silence)
      this.vad.flush()
    }
    return { partial, finals: this.drain() }
  }

  /** 维护滚动尾音缓冲(容量 = tailPadSeconds)。 */
  private pushTail(samples: Float32Array): void {
    this.tailBuf.push(samples)
    this.tailLen += samples.length
    const cap = Math.round(16000 * (this.options.tailPadSeconds ?? 0.6))
    while (this.tailLen > cap && this.tailBuf.length > 0) {
      const first = this.tailBuf[0]
      if (first === undefined) break
      const excess = this.tailLen - cap
      if (first.length <= excess) {
        this.tailLen -= first.length
        this.tailBuf.shift()
      } else {
        this.tailBuf[0] = first.subarray(first.length - excess)
        this.tailLen = cap
        break
      }
    }
  }

  /** 当前尾音缓冲拼接(voxelf: 追加进每个弹出段的识别输入)。 */
  private tailAudio(): Float32Array {
    if (this.tailBuf.length === 0) return new Float32Array(0)
    const out = new Float32Array(this.tailLen)
    let offset = 0
    for (const part of this.tailBuf) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  /** 弹出全部已定稿的 VAD 段:段样本(精确 onset)+ 尾音补偿解码 = 定稿文本;
   * live stream 仅服务 partial,段弹出后作废。 */
  private drain(): string[] {
    const out: string[] = []
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front()
      this.vad.pop()
      this.liveStream = null // partial 流随段定稿作废(下一句话重建)
      // 段样本(含精确句首)+ 尾音补偿(渐弱尾音)
      const input = new Float32Array(seg.samples.length + this.tailLen)
      input.set(seg.samples, 0)
      input.set(this.tailAudio(), seg.samples.length)
      const stream = this.recognizer.createStream()
      for (let i = 0; i < input.length; i += 1600) {
        stream.acceptWaveform({ sampleRate: 16000, samples: input.subarray(i, i + 1600) })
        while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
      }
      stream.inputFinished()
      while (this.recognizer.isReady(stream)) this.recognizer.decode(stream)
      const text = this.recognizer.getResult(stream).text
      if (text !== '') out.push(text)
    }
    return out
  }
}
