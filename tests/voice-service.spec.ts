import { describe, expect, it, vi } from 'vitest'
import { createVoiceService } from '../src/client/voice-service'
import { VOICE_CHANNEL, VOICE_ENDPOINTS, VoiceRpcError } from '../src/core/wire'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection'

function okCall<T>(value: T) {
  return vi.fn(async (): Promise<RpcResult<unknown>> => ({ ok: true, value }))
}

describe('createVoiceService(解码 + 错误翻译的唯一住处)', () => {
  it('ping: 走 /voice.ping,返回解码后的生效引擎', async () => {
    const call = okCall({ engine: 'native' })
    const voice = createVoiceService(call as never)
    await expect(voice.ping()).resolves.toEqual({ engine: 'native' })
    expect(call).toHaveBeenCalledWith(VOICE_CHANNEL, VOICE_ENDPOINTS.ping, {})
  })

  it('fetchConfig: 走 /voice.config,返回解码后的配置', async () => {
    const call = okCall({ engine: 'browser', hotkey: 'alt+m' })
    const voice = createVoiceService(call as never)
    await expect(voice.fetchConfig()).resolves.toEqual({ engine: 'browser', hotkey: 'alt+m' })
    expect(call).toHaveBeenCalledWith(VOICE_CHANNEL, VOICE_ENDPOINTS.config, {})
  })

  it('asr: 走 /voice.asr,payload 原样透传', async () => {
    const payload = { sessionId: 's1', audio: 'aGk=', final: false }
    const call = okCall({ delta: '部分', final: false })
    const voice = createVoiceService(call as never)
    await expect(voice.asr(payload)).resolves.toEqual({ delta: '部分', final: false })
    expect(call).toHaveBeenCalledWith(VOICE_CHANNEL, VOICE_ENDPOINTS.asr, payload)
  })

  it('ok:false → 抛 VoiceRpcError 且保留 code', async () => {
    const call = vi.fn(async (): Promise<RpcResult<unknown>> => ({
      ok: false,
      error: { code: 'native_unavailable', message: '模型不可用', details: {} },
    }))
    const voice = createVoiceService(call as never)
    const err = await voice.asr({ sessionId: 's1', audio: '', final: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceRpcError)
    expect((err as VoiceRpcError).code).toBe('native_unavailable')
    expect((err as VoiceRpcError).message).toBe('模型不可用')
  })

  it('传输异常原样传播(不包装)', async () => {
    const call = vi.fn(async () => { throw new Error('transport down') })
    const voice = createVoiceService(call as never)
    await expect(voice.ping()).rejects.toThrow('transport down')
  })
})
