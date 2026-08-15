/**
 * HostAsr —— host 侧识别会话池 + asr 端点逻辑(deep module)。
 *
 * 接口:handle(model, req) → 线协议结果。内部独占:
 * base64 → Int16 解码、按 sessionId 的识别会话池(LRU 驱逐)、
 * feed 与错误映射 —— 全部可经假模型直接单测,不需要真模型。
 *
 * seam:AsrModelFace / AsrSessionFace 两个结构形状 —— OnnxModel 零改动
 * 即满足(真实 adapter),测试假模型是第二个 adapter,接缝成真。
 *
 * 驱逐策略:maxSessions 满时逐出最久未用的会话,经 log 回调留痕。
 * 被逐出的会话若还在说话,VAD 状态从零开始、一句话会被拆断 ——
 * 这是有意的容量取舍(防 VAD 状态无界累积),非 bug。
 */
import type { RpcResult } from '@deepseek-ai/dsh-client-connection'
import { rpcError } from './wire.js'
import type { AsrChunkPayload, AsrChunkResponse } from '../types.js'

/** 一次识别会话的喂入面(feed 结果只经返回值交付)。 */
export interface AsrSessionFace {
  feed(int16: Int16Array, final: boolean): { partial: string; finals: string[] }
}

/** 模型面(开一个新识别会话;模型未加载返回 null)。 */
export interface AsrModelFace {
  openSession(): AsrSessionFace | null
}

export interface HostAsrOptions {
  /** 同时存活的识别会话上限(LRU 淘汰) */
  maxSessions?: number
  /** 会话被驱逐 / feed 失败时的留痕回调(默认静默) */
  log?: (message: string) => void
}

/** 会话池容量默认值(防 VAD 状态无界累积;无配置面,不进 DEFAULTS)。 */
const DEFAULT_MAX_SESSIONS = 4

export class HostAsr {
  private readonly sessions = new Map<string, { session: AsrSessionFace; lastUsed: number }>()
  private readonly maxSessions: number
  private readonly log: ((message: string) => void) | undefined
  /** 单调时钟:lastUsed 用计数而非墙钟,LRU 顺序确定可测 */
  private tick = 0

  constructor(options: HostAsrOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.log = options.log
  }

  /** 处理一块 asr payload:解码 → 会话池取会话 → feed → 线协议结果。 */
  handle(model: AsrModelFace, req: AsrChunkPayload): RpcResult<AsrChunkResponse> {
    const session = this.sessionFor(model, req.sessionId)
    if (session === null) {
      return rpcError('native_unavailable', 'native ASR 不可用')
    }
    const chunk = Buffer.from(req.audio, 'base64')
    const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    try {
      const out = session.feed(int16, req.final)
      // 定稿优先;否则回传当前部分识别文本(边说边出字)
      const delta = out.finals.length > 0 ? out.finals.join('') : out.partial
      return { ok: true, value: { delta, final: out.finals.length > 0 } }
    } catch (err) {
      // 单次 feed 失败不报废整个识别服务(按块错误)
      this.log?.(`feed 失败: ${String(err)}`)
      return rpcError('internal', String(err))
    }
  }

  /** 按 sessionId 取独立识别会话(LRU 淘汰最久未用的)。 */
  private sessionFor(model: AsrModelFace, sessionId: string): AsrSessionFace | null {
    const hit = this.sessions.get(sessionId)
    if (hit !== undefined) {
      hit.lastUsed = ++this.tick
      return hit.session
    }
    const session = model.openSession()
    if (session === null) return null
    while (this.sessions.size >= this.maxSessions) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, value] of this.sessions) {
        if (value.lastUsed < oldestTime) {
          oldestTime = value.lastUsed
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      this.sessions.delete(oldestKey)
      this.log?.(`会话 ${oldestKey} 被 LRU 驱逐(满 ${this.maxSessions})`)
    }
    this.sessions.set(sessionId, { session, lastUsed: ++this.tick })
    return session
  }
}
