/**
 * OnnxRecognizer —— 原生流式 ASR(sherpa-onnx-node:zipformer2 + silero VAD)。
 *
 * seam 事实:动态 import(缺包 → start() reject);输入 PCM(Int16 16kHz 单声道),
 * 内部转 Float32 → VAD 分段 → 流式解码;onText 增量回调。
 * VAD 收尾需要静音冲刷:stop()/final=true 时喂 0.8s 静音再取尾段。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { SpeechRecognizer } from './asr'

/** ESM 产物下的 CJS 动态加载入口 */
const require = createRequire(import.meta.url)

export interface OnnxRecognizerOptions {
  /** voxelf assets/models 的绝对路径 */
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

export class OnnxRecognizer implements SpeechRecognizer {
  private readonly textCbs = new Set<(delta: string, final: boolean) => void>()
  private readonly errorCbs = new Set<(err: Error) => void>()
  private recognizer: OnlineRecognizerLike | null = null
  private vad: VadLike | null = null
  private loadFailed = false
  /** 滚动尾音缓冲:保存最近 tailPadSeconds 的音频,段弹出时追加进识别输入
   * (voxelf tail_buf 机制,补偿渐弱尾音被 VAD 截断) */
  private readonly tailBuf: Float32Array[] = []
  private tailLen = 0
  /** 当前语音的 live 识别流(边说边出字;VAD 弹出定稿段时 inputFinished) */
  private liveStream: OnlineStreamLike | null = null

  constructor(private readonly options: OnnxRecognizerOptions) {}

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
    this.vad = new onnx.Vad({
      sileroVad: {
        model: join(dir, 'vad', 'silero_vad.onnx'),
        threshold: this.options.vadThreshold ?? 0.3,
        minSpeechDuration: 0.25,
        minSilenceDuration: this.options.minSilenceSeconds ?? 0.5,
        windowSize: 512,
        maxSpeechDuration: 20,
      },
      sampleRate: 16000,
      numThreads: 1,
    }, 30)
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

  /** 喂入一段 Int16 PCM。
   * partial = 当前语音的实时部分识别文本(边说边出字,累计);
   * finals = 本段弹出的定稿句(VAD 判定一句话结束)。
   * final=true 时补静音冲刷尾段;空块(final 收尾)绝不喂给 VAD
   * (native 层对 0 长度 samples 会报 nullptr)。 */
  feed(int16: Int16Array, final: boolean): { partial: string; finals: string[] } {
    if (this.recognizer === null || this.vad === null) return { partial: '', finals: [] }
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
    if (this.recognizer === null || this.vad === null) return []
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
      if (text !== '') {
        out.push(text)
        for (const cb of this.textCbs) cb(text, true)
      }
    }
    return out
  }

  stop(): void {
    // 幂等;下一次 feed(final=true) 会冲刷
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

/** 裁剪头部静音(能量门限 + 5ms 窗口);全静音返回空。margin 保留少量上下文。 */
function trimLeadingSilence(samples: Float32Array, threshold = 0.01, margin = 1600): Float32Array {
  const window = 80 // 5ms @16k
  let onset = -1
  for (let i = 0; i + window <= samples.length; i += window) {
    let energy = 0
    for (let j = i; j < i + window; j += 1) energy += (samples[j] ?? 0) ** 2
    if (Math.sqrt(energy / window) > threshold) {
      onset = i
      break
    }
  }
  if (onset < 0) return new Float32Array(0)
  return samples.subarray(Math.max(0, onset - margin))
}
