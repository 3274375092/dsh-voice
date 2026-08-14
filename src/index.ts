/**
 * dsh-voice host 半(web profile 的 Node 侧)。
 * 纯语音输入:/voice RPC 通道(connection.rpc,loopback authority)接收浏览器
 * 采麦 PCM → 流式 ASR(sherpa-onnx-node zipformer2 + silero VAD)→ 增量文本回传。
 * 与 agent preset 解耦:任何 preset(code/standard/minimal/whale/…)下都只是
 * "另一种输入法",回复展示由会话本身负责。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { OnnxRecognizer } from './core/native-asr'
import type { AsrChunkPayload, AsrChunkResponse, VoicePingResponse } from './types'

export const name = 'dsh-voice-host'
export const inject = ['connection']

export interface Config {
  /** 'browser' = 客户端 Web Speech(host 不识别);'native' = sherpa-onnx-node */
  engine: 'browser' | 'native'
  /** voxelf assets/models 的绝对路径(native 引擎用) */
  modelDir: string
  /** VAD 静音阈值(0-1);越低越不容易吞句首/句尾,但更容易把噪声当语音(voxelf 生产值 0.3) */
  vadThreshold: number
  /** 尾音补偿时长(秒);VAD 段后追加的音频时长,补偿渐弱尾音(voxelf 生产值 0.6) */
  tailPadSeconds: number
  /** ASR 模型子目录: asr-zh(纯中文,默认)| asr-zh-en-2025(中英双语) */
  asrDir: string
}

export const Config: z<Config> = z.object({
  engine: z.union([z.const('browser'), z.const('native')]).default('native'),
  modelDir: z.string().default(''),
  vadThreshold: z.number().min(0).default(0.3),
  tailPadSeconds: z.number().min(0).default(0.6),
  asrDir: z.string().default('asr-zh'),
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  let recognizer: OnnxRecognizer | null = null
  let asrFailed = false

  /** 懒加载 zipformer2 + VAD(首次 asr 请求时初始化;失败只降级不炸插件)。 */
  const ensureAsr = async (): Promise<OnnxRecognizer | null> => {
    if (config.modelDir.trim() === '' || asrFailed) return null
    if (recognizer === null) {
      recognizer = new OnnxRecognizer({
        modelDir: config.modelDir,
        asrDir: config.asrDir,
        vadThreshold: config.vadThreshold,
        tailPadSeconds: config.tailPadSeconds,
      })
    }
    try {
      await recognizer.start()
    } catch (err) {
      asrFailed = true
      logger.warn('native ASR 初始化失败: %s', String(err))
      return null
    }
    return recognizer
  }

  const nativeReady = (): boolean => config.modelDir.trim() !== '' && !asrFailed

  ctx.effect(() => ctx.connection.rpc.handle('/voice', async (endpoint, payload) => {
    if (endpoint === 'ping') {
      const value: VoicePingResponse = { ok: true, native: nativeReady() }
      return { ok: true, value }
    }
    if (endpoint === 'asr') {
      const req = payload as AsrChunkPayload
      if (config.engine !== 'native') {
        return { ok: false, error: { code: 'internal', message: 'native ASR disabled', details: {} } }
      }
      const rec = await ensureAsr()
      if (rec === null) {
        return { ok: false, error: { code: 'internal', message: 'ASR 模型不可用', details: {} } }
      }
      const chunk = Buffer.from(req.audio, 'base64')
      const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
      try {
        const out = rec.feed(int16, req.final)
        // 定稿优先;否则回传当前部分识别文本(边说边出字)
        const delta = out.finals.length > 0 ? out.finals.join('') : out.partial
        const response: AsrChunkResponse = { delta, final: out.finals.length > 0 }
        return { ok: true, value: response }
      } catch (err) {
        // 单次 feed 失败不报废整个识别服务
        logger.warn('native ASR feed 失败: %s', String(err))
        return { ok: false, error: { code: 'internal', message: String(err), details: {} } }
      }
    }
    return { ok: false, error: { code: 'internal', message: 'unknown endpoint: ' + endpoint, details: {} } }
  }, { authority: 'loopback' }), 'dsh-voice: /voice rpc channel')
}
