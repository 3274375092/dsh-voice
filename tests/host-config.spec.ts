import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index'

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

describe('host /voice.config(行内 config → client 半的同步口)', () => {
  it('返回行内配置的 engine 与 hotkey', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ engine: 'browser', hotkey: 'alt+m' }))
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'browser', hotkey: 'alt+m' } })
  })

  it('零配置(未写 engine/modelDir)默认 auto,保持 ping → Web Speech 兜底', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({}))
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'auto', hotkey: 'ctrl+space' } })
  })

  it('显式 native 但模型目录为空 → 回退 auto,不掐断浏览器识别', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ engine: 'native' }))
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'auto', hotkey: 'ctrl+space' } })
  })

  it('显式 native 且模型目录已配 → 保持 native', async () => {
    const { ctx, call } = hostContext()
    apply(ctx as never, Config({ engine: 'native', modelDir: './dsh-voice-models' }))
    const res = await call('config') as { ok: boolean; value: { engine: string; hotkey: string } }
    expect(res).toEqual({ ok: true, value: { engine: 'native', hotkey: 'ctrl+space' } })
  })
})
