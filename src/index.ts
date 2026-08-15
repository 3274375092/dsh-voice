/**
 * dsh-voice host 半(web profile 的 Node 侧)。
 * 纯语音输入:/voice RPC 通道(connection.rpc,loopback authority)接收浏览器
 * 采麦 PCM → 流式 ASR(sherpa-onnx-node zipformer2 + silero VAD)→ 增量文本回传。
 * 与 agent preset 解耦:任何 preset(code/standard/minimal/whale/…)下都只是
 * "另一种输入法",回复展示由会话本身负责。
 * 模型权重全局一份;识别状态按 sessionId 隔离(LRU 上限),并发会话不串音。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { OnnxModel, type AsrModelOptions, type OnnxSession } from './core/native-asr.js'
import type { AsrChunkPayload, AsrChunkResponse, VoicePingResponse } from './types.js'

export const name = 'dsh-voice-host'
export const inject = ['connection']

/** 同时存活的识别会话上限(LRU 淘汰,防止 VAD 状态无界累积)。 */
const MAX_SESSIONS = 4

/** host 半配置:引擎开关 + 模型选项(modelDir/asrDir/vadThreshold/tailPadSeconds
 * 与 AsrModelOptions 共享形状,单一来源,不再逐字段透传)。
 * engine 与 client 半共用同一行 config:两半 schema 都接受 auto ——
 * host 半的 auto = 有模型就提供 native(探测逻辑在 client 半)。 */
export interface Config extends Pick<AsrModelOptions, 'modelDir' | 'asrDir' | 'vadThreshold' | 'tailPadSeconds'> {
  /** 'browser' = 强制关闭原生识别;'native'/'auto' = 有模型就提供原生识别 */
  engine: 'browser' | 'native' | 'auto'
  /** VAD 静音阈值(0-1);越低越不容易吞句首/句尾,但更容易把噪声当语音(voxelf 生产值 0.3) */
  vadThreshold: number
  /** 尾音补偿时长(秒);VAD 段后追加的音频时长,补偿渐弱尾音(voxelf 生产值 0.6) */
  tailPadSeconds: number
  /** ASR 模型子目录: asr-zh(纯中文,默认)| asr-zh-en-2025(中英双语) */
  asrDir: string
}

export const Config: z<Config> = z.object({
  engine: z.union([z.const('browser'), z.const('native'), z.const('auto')]).default('native'),
  modelDir: z.string().default(''),
  vadThreshold: z.number().min(0).default(0.3),
  tailPadSeconds: z.number().min(0).default(0.6),
  asrDir: z.string().default('asr-zh'),
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  let model: OnnxModel | null = null
  let asrFailed = false
  const sessions = new Map<string, { session: OnnxSession; lastUsed: number }>()

  /** 懒加载 zipformer2 + VAD(首次 asr 请求时初始化;失败只降级不炸插件)。 */
  const ensureAsr = async (): Promise<OnnxModel | null> => {
    if (config.modelDir.trim() === '' || asrFailed) return null
    if (model === null) {
      model = new OnnxModel(config)
    }
    try {
      await model.start()
    } catch (err) {
      asrFailed = true
      logger.warn('native ASR 初始化失败: %s', String(err))
      return null
    }
    return model
  }

  /** 按 sessionId 取独立识别会话(LRU 淘汰最久未用的)。 */
  const sessionFor = (sessionId: string, m: OnnxModel): OnnxSession | null => {
    const hit = sessions.get(sessionId)
    if (hit !== undefined) {
      hit.lastUsed = Date.now()
      return hit.session
    }
    const session = m.openSession()
    if (session === null) return null
    while (sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, value] of sessions) {
        if (value.lastUsed < oldestTime) {
          oldestTime = value.lastUsed
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      sessions.delete(oldestKey)
    }
    sessions.set(sessionId, { session, lastUsed: Date.now() })
    return session
  }

  /** host 原生能力:engine 未强制关闭 + 模型目录已配 + 加载未失败。 */
  const nativeReady = (): boolean =>
    config.engine !== 'browser' && config.modelDir.trim() !== '' && !asrFailed

  ctx.effect(() => ctx.connection.rpc.handle('/voice', async (endpoint, payload) => {
    if (endpoint === 'ping') {
      const value: VoicePingResponse = { ok: true, native: nativeReady() }
      return { ok: true, value }
    }
    if (endpoint === 'asr') {
      const req = payload as AsrChunkPayload
      if (config.engine === 'browser') {
        return { ok: false, error: { code: 'internal', message: 'native ASR disabled', details: {} } }
      }
      const m = await ensureAsr()
      if (m === null) {
        return { ok: false, error: { code: 'internal', message: 'ASR 模型不可用', details: {} } }
      }
      const session = sessionFor(req.sessionId, m)
      if (session === null) {
        return { ok: false, error: { code: 'internal', message: 'ASR 模型不可用', details: {} } }
      }
      const chunk = Buffer.from(req.audio, 'base64')
      const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
      try {
        const out = session.feed(int16, req.final)
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
