import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index'
import type { OnnxModel, OnnxSession } from '../src/core/native-asr'

/** 最小的 host Context 桩:只覆盖插件用到的 connection/logger/effect。 */
function hostContext() {
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    connection: {
      rpc: {
        handle(_channel: string, next: typeof handler) {
          handler = next
          return () => {}
        },
      },
    },
    effect(fn: () => unknown) {
      fn()
      return () => {}
    },
  }
  return { ctx, call: (endpoint: string, payload: unknown = {}) => handler!(endpoint, payload, new AbortController().signal) }
}

/** 假模型:只够支撑 config/ping 端点的能力判定;asr 端点未覆盖(候选 6)。 */
function fakeModel(): OnnxModel {
  return { start: async () => {}, openSession: () => ({ feed: () => ({ partial: '', finals: [] }) }) as unknown as OnnxSession } as unknown as OnnxModel
}

function applyHost(config: Record<string, unknown>, modelDir?: string) {
  const { ctx, call } = hostContext()
  apply(ctx as never, Config({ ...config, ...(modelDir !== undefined ? { modelDir } : {}) }))
  return { call }
}

describe('host 引擎决策(/voice.ping + /voice.config 下发生效引擎)', () => {
  it('browser 强制:无论模型能力如何都下发 browser', async () => {
    const { call } = applyHost({ engine: 'browser', hotkey: 'alt+m' }, './dsh-voice-models')
    const ping = await call('ping') as { ok: boolean; value: { engine: string } }
    const config = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(ping).toEqual({ ok: true, value: { engine: 'browser' } })
    expect(config).toEqual({ ok: true, value: { engine: 'browser', hotkey: 'alt+m' } })
  })

  it('零配置(默认 auto、无模型目录):加载器不加载,下发 browser 兜底', async () => {
    const { call } = applyHost({})
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'browser', hotkey: 'ctrl+space' } })
  })

  it('显式 native 但模型目录为空:能力为假,下发 browser 兜底', async () => {
    const { call } = applyHost({ engine: 'native' })
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'browser', hotkey: 'ctrl+space' } })
  })

  it('模型加载成功 → 下发 native', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ engine: 'native', modelDir: './m' }), { loadModel: async () => fakeModel() })
    const ping = await call('ping') as { ok: boolean; value: { engine: string } }
    const config = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(ping).toEqual({ ok: true, value: { engine: 'native' } })
    expect(config).toEqual({ ok: true, value: { engine: 'native', hotkey: 'ctrl+space' } })
  })

  it('模型加载失败 → 下发 browser(不再虚报 native)', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ engine: 'native', modelDir: './m' }), { loadModel: async () => null })
    const ping = await call('ping') as { ok: boolean; value: { engine: string } }
    expect(ping).toEqual({ ok: true, value: { engine: 'browser' } })
  })

  it('auto + 模型加载成功 → 下发 native;加载失败 → browser', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ modelDir: './m' }), { loadModel: async () => fakeModel() })
    expect(((await call('ping')) as { value: { engine: string } }).value.engine).toBe('native')
    const { ctx: ctx2, call: call2 } = hostContext()
    apply(ctx2 as never, Config({ modelDir: './m' }), { loadModel: async () => null })
    expect(((await call2('ping')) as { value: { engine: string } }).value.engine).toBe('browser')
  })

  it('未知端点 → unknown_endpoint 错误码', async () => {
    const { call } = applyHost({})
    const res = await call('nope') as { ok: boolean; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('unknown_endpoint')
  })
})
