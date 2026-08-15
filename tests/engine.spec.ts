import { describe, expect, it, vi } from 'vitest'
import { createCapability, resolveEngine } from '../src/core/engine'

describe('resolveEngine(配置 + 能力 → 生效引擎)', () => {
  it('browser 强制:无论能力如何都是 browser', () => {
    expect(resolveEngine('browser', true)).toBe('browser')
    expect(resolveEngine('browser', false)).toBe('browser')
  })

  it('auto:有能力 → native,无能力 → browser', () => {
    expect(resolveEngine('auto', true)).toBe('native')
    expect(resolveEngine('auto', false)).toBe('browser')
  })

  it('native 强制:有能力 → native;不可用 → 兜底 browser', () => {
    expect(resolveEngine('native', true)).toBe('native')
    expect(resolveEngine('native', false)).toBe('browser')
  })
})

describe('createCapability(懒加载 + 单飞 + 失败锁存)', () => {
  it('ready 首次调用触发加载,幂等复用结果', async () => {
    const load = vi.fn(async () => ({ ok: true }))
    const cap = createCapability(load)
    expect(cap.state()).toBe('idle')
    const first = await cap.ready()
    const second = await cap.ready()
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(load).toHaveBeenCalledTimes(1)
    expect(cap.state()).toBe('ready')
  })

  it('kick 预载后 ready 直接复用,不二次加载', async () => {
    const load = vi.fn(async () => 'model')
    const cap = createCapability(load)
    cap.kick()
    expect(cap.state()).toBe('loading')
    await cap.ready()
    await cap.ready()
    expect(load).toHaveBeenCalledTimes(1)
    expect(cap.state()).toBe('ready')
  })

  it('加载返回 null → 失败锁存,不再重试', async () => {
    const load = vi.fn(async () => null)
    const cap = createCapability(load)
    expect(await cap.ready()).toBeNull()
    expect(await cap.ready()).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    expect(cap.state()).toBe('failed')
  })

  it('加载抛错 → 视为 null,锁存 failed', async () => {
    const load = vi.fn(async () => { throw new Error('load boom') })
    const cap = createCapability(load)
    expect(await cap.ready()).toBeNull()
    expect(await cap.ready()).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    expect(cap.state()).toBe('failed')
  })

  it('加载在途时并发 ready 只触发一次加载', async () => {
    let resolveLoad!: (v: string | null) => void
    const load = vi.fn(() => new Promise<string | null>((resolve) => { resolveLoad = resolve }))
    const cap = createCapability(load)
    const a = cap.ready()
    const b = cap.ready()
    await Promise.resolve() // 让 load 被微任务调度到
    resolveLoad('m')
    expect(await a).toBe('m')
    expect(await b).toBe('m')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
