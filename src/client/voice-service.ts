/**
 * voice-service —— /voice 通道的客户端调用面(deep module)。
 *
 * 接口(3 个方法):ping / fetchConfig / asr。每个方法独占一条端点的
 * 通道常量、RpcResult 解码与错误翻译 —— wire 类型只在这里断言一次,
 * 调用方拿到的是已解码的领域值,不再各自 res.value as。
 * call 注入(测试第二个 adapter):(channel, endpoint, payload) → RpcResult。
 * 错误:ok:false → 抛 VoiceRpcError(保留 code);传输异常原样传播。
 */
import type { RpcResult } from '@deepseek-ai/dsh-client-connection'
import { VOICE_CHANNEL, VOICE_ENDPOINTS, VoiceRpcError } from '../core/wire.js'
import type { AsrChunkPayload, AsrChunkResponse, VoiceClientConfig, VoicePingResponse } from '../types.js'

export type RpcCall = (channel: string, endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>

export interface VoiceService {
  ping(): Promise<VoicePingResponse>
  fetchConfig(): Promise<VoiceClientConfig>
  asr(payload: AsrChunkPayload): Promise<AsrChunkResponse>
}

function decode<T>(res: RpcResult<unknown>): T {
  if (!res.ok) throw new VoiceRpcError(res.error.code, res.error.message)
  return res.value as T
}

export function createVoiceService(call: RpcCall): VoiceService {
  return {
    ping: async () => decode<VoicePingResponse>(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.ping, {})),
    fetchConfig: async () => decode<VoiceClientConfig>(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.config, {})),
    asr: async (payload) => decode<AsrChunkResponse>(await call(VOICE_CHANNEL, VOICE_ENDPOINTS.asr, payload)),
  }
}
