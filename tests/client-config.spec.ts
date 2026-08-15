import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/client/index'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  IconStopFill16: () => null,
}))

/** 最小 client Context 桩:覆盖 slots/sessions/connection/effect。 */
function clientContext(remote: { engine: string; hotkey: string }) {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  let slotInjection: (() => () => void) | undefined
  const registrations: Array<{ inject?: (sessionId: string) => any }> = []
  const ctx: any = {
    slots: {
      inject(_name: string, factory: () => () => void) { slotInjection = factory },
      register(options: any) { registrations.push(options); return () => {} },
    },
    sessions: { list: { getSnapshot: () => ({}) } },
    connection: {
      rpc: {
        async call(channel: string, endpoint: string, payload: unknown) {
          calls.push({ channel, endpoint, payload })
          return { ok: true, value: remote }
        },
      },
    },
    effect() { return () => {} },
  }
  return { ctx, calls, registrations, mount: () => slotInjection!() }
}

describe('client 半配置同步(web shell 不传行内 config)', () => {
  it('apply 先使用默认值,再经 /voice.config 用 host 行内值覆盖 hotkey', async () => {
    const { ctx, calls, registrations, mount } = clientContext({ engine: 'browser', hotkey: 'alt+m' })
    apply(ctx, Config({}))
    mount()
    const before = registrations[0]!.inject!('sess-1').hooks.hotkey.getSnapshot()
    expect(before).toBe('Ctrl+空格')

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(calls).toEqual([{ channel: '/voice', endpoint: 'config', payload: {} }])
    const after = registrations[0]!.inject!('sess-1').hooks.hotkey.getSnapshot()
    expect(after).toBe('Alt+M')
  })

  it('RPC 失败时保留 client schema 默认值,不抛异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, registrations, mount } = clientContext({ engine: 'native', hotkey: 'ctrl+space' })
    ctx.connection.rpc.call = async () => { throw new Error('host down') }
    apply(ctx, Config({}))
    mount()
    await new Promise(resolve => setTimeout(resolve, 0))

    const face = registrations[0]!.inject!('sess-1')
    expect(face.hooks.hotkey.getSnapshot()).toBe('Ctrl+空格')
    expect(face.hooks.listening.getSnapshot()).toBe(false)
    warn.mockRestore()
  })
})
