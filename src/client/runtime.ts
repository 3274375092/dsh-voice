/**
 * VoiceRuntime —— 客户端语音运行时(deep module)。
 *
 * 接口(组件只碰这几个方法):getEngine / isListening / subscribe /
 * toggleMic / stopMic / createTts / notifyControl。
 * 实现:引擎探测(host /voice.ping → native 否则 browser)、麦克风采集
 * (ScriptProcessor PCM 16kHz→base64 分块)、识别→提交(conversation 服务)、
 * 状态通知(极简 listener 列表)。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationService } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RpcRecognizer, WebSpeechRecognizer, type SpeechRecognizer } from '../core/asr'
import type { AsrChunkPayload, AsrChunkResponse, VoiceEngine, VoicePingResponse } from '../types'

export interface VoiceRuntimeConfig {
  /** 'auto' = ping host 探测;'browser'/'native' 强制 */
  engine: VoiceEngine
}

/** 麦克风采集句柄(stop 幂等)。 */
interface MicCapture {
  stop(): void
}

export class VoiceRuntime {
  private engine: VoiceEngine | null = null
  private listening = false
  private recognizer: SpeechRecognizer | null = null
  private capture: MicCapture | null = null
  /** 本轮已定稿的识别文本(停麦时提交) */
  private pendingText = ''
  /** 当前部分识别文本(边说边出字,未定稿) */
  private partialText = ''
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly ctx: ClientContext,
    private readonly config: VoiceRuntimeConfig,
  ) {}

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
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }

  /** 开关一轮识别。resolve 表示状态已切换(识别结果在后续回调提交)。 */
  async toggleMic(sessionId: string): Promise<void> {
    if (this.listening) {
      await this.stopMic(sessionId)
      return
    }
    this.listening = true
    this.pendingText = ''
    this.partialText = ''
    this.notify()
    const engine = await this.getEngine()
    if (engine === 'browser') {
      const rec = new WebSpeechRecognizer()
      rec.onText((text, final) => {
        if (final) {
          this.pendingText = text
          this.partialText = ''
          this.notify()
          void this.stopMic(sessionId)
        } else {
          this.partialText = text
          this.notify()
        }
      })
      rec.onError((err) => {
        this.pendingText = ''
        void this.stopMic(sessionId).then(() => { console.error('dsh-voice ASR:', err) })
      })
      this.recognizer = rec
      try {
        await rec.start()
      } catch (err) {
        this.listening = false
        this.notify()
        throw err
      }
      return
    }
    // native:采麦 → 分块 → host ASR → 累积文本
    const rec = new RpcRecognizer(
      { callAsr: (payload) => this.callAsr(payload) },
      sessionId,
    )
    rec.onText((text, final) => {
      if (final) {
        this.pendingText += text
        this.partialText = ''
      } else {
        this.partialText = text
      }
      this.notify()
    })
    rec.onError((err) => { console.error('dsh-voice ASR:', err) })
    this.recognizer = rec
    this.capture = await capturePcm((int16) => {
      void rec.pushChunk(encodeBase64(int16), false)
    })
  }

  /** 停止识别;pendingText 非空则作为一条用户消息提交。 */
  async stopMic(sessionId: string): Promise<void> {
    const rec = this.recognizer
    if (rec instanceof RpcRecognizer) {
      // 关键:发 final=true 空块,让 host 补静音冲刷 VAD 弹出最后一段
      try {
        await rec.pushChunk('', true)
      } catch (err) {
        console.error('dsh-voice ASR 收尾失败:', err)
      }
    }
    this.capture?.stop()
    this.capture = null
    rec?.stop()
    this.recognizer = null
    const text = (this.pendingText + this.partialText).trim()
    this.pendingText = ''
    this.partialText = ''
    this.listening = false
    this.notify()
    if (text !== '') await this.submitText(sessionId, text)
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

/** 采集麦克风 PCM(Int16 16kHz 单声道);ScriptProcessor 为 v1 实现(可换 AudioWorklet)。 */
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
