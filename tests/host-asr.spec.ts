import { describe, expect, it, vi } from 'vitest'
import { HostAsr, type AsrModelFace, type AsrSessionFace } from '../src/core/host-asr'
import { encodeBase64 } from '../src/client/audio'

function payload(over: Partial<{ sessionId: string; audio: string; final: boolean }> = {}) {
  return { sessionId: 's1', audio: '', final: false, ...over }
}

/** 假模型:记录 openSession 调用,每次返回独立假会话(可逐会话控制 feed)。 */
function fakeModel() {
  const feeds: ReturnType<typeof vi.fn>[] = []
  const openSession = vi.fn((): AsrSessionFace | null => {
    const feed = vi.fn(() => ({ partial: '', finals: [] }))
    feeds.push(feed)
    return { feed }
  })
  return { model: { openSession }, openSession, feeds }
}

describe('HostAsr(解码 → 会话池 → feed → 线协议结果)', () => {
  it('解码:base64 → Int16 值 + final 标志原样进 feed', () => {
    const m = fakeModel()
    const pool = new HostAsr({ maxSessions: 2 })
    const res = pool.handle(m.model, payload({ audio: encodeBase64(new Int16Array([1, -2, 300])), final: false }))
    expect(res).toEqual({ ok: true, value: { delta: '', final: false } })
    const call = m.feeds[0]!.mock.calls[0]!
    expect(Array.from(call[0] as Int16Array)).toEqual([1, -2, 300])
    expect(call[1]).toBe(false)
  })

  it('空块冲刷:audio 空串 → 空 Int16Array + final:true', () => {
    const m = fakeModel()
    const pool = new HostAsr()
    pool.handle(m.model, payload({ audio: '', final: true }))
    const call = m.feeds[0]!.mock.calls[0]!
    expect(Array.from(call[0] as Int16Array)).toEqual([])
    expect(call[1]).toBe(true)
  })

  it('响应映射:finals 优先,否则回传 partial', () => {
    const m = fakeModel()
    const pool = new HostAsr()
    pool.handle(m.model, payload()) // 首次:开会话(feeds[0] 就位)
    m.feeds[0]!.mockReturnValue({ partial: '部分', finals: ['你好'] })
    expect(pool.handle(m.model, payload())).toEqual({ ok: true, value: { delta: '你好', final: true } })
    m.feeds[0]!.mockReturnValue({ partial: '边说', finals: [] })
    expect(pool.handle(m.model, payload())).toEqual({ ok: true, value: { delta: '边说', final: false } })
  })

  it('openSession 返回 null → native_unavailable', () => {
    const model: AsrModelFace = { openSession: () => null }
    const res = new HostAsr().handle(model, payload())
    expect(res).toEqual({ ok: false, error: { code: 'native_unavailable', message: 'native ASR 不可用', details: {} } })
  })

  it('feed 抛错 → internal + log 留痕(单块失败不报废服务)', () => {
    const log = vi.fn()
    const model: AsrModelFace = {
      openSession: () => ({ feed: () => { throw new Error('boom') } }),
    }
    const res = new HostAsr({ log }).handle(model, payload())
    expect(res).toEqual({ ok: false, error: { code: 'internal', message: 'Error: boom', details: {} } })
    expect(log).toHaveBeenCalledWith('feed 失败: Error: boom')
  })

  it('LRU 驱逐:满员时逐出最久未用,log 留痕;被逐 id 重新进来开新会话', () => {
    const log = vi.fn()
    const m = fakeModel()
    const pool = new HostAsr({ maxSessions: 2, log })
    pool.handle(m.model, payload({ sessionId: 's1' }))
    pool.handle(m.model, payload({ sessionId: 's2' }))
    pool.handle(m.model, payload({ sessionId: 's3' }))
    expect(m.openSession).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith('会话 s1 被 LRU 驱逐(满 2)')
    pool.handle(m.model, payload({ sessionId: 's1' }))
    expect(m.openSession).toHaveBeenCalledTimes(4)
  })

  it('LRU 顺序:最近使用过的会话不被驱逐', () => {
    const log = vi.fn()
    const m = fakeModel()
    const pool = new HostAsr({ maxSessions: 2, log })
    pool.handle(m.model, payload({ sessionId: 's1' }))
    pool.handle(m.model, payload({ sessionId: 's2' }))
    pool.handle(m.model, payload({ sessionId: 's1' })) // 触碰 s1:它不再是最久未用
    pool.handle(m.model, payload({ sessionId: 's3' }))
    expect(log).toHaveBeenCalledWith('会话 s2 被 LRU 驱逐(满 2)')
  })

  it('会话复用:同一 sessionId 只 openSession 一次', () => {
    const m = fakeModel()
    const pool = new HostAsr()
    pool.handle(m.model, payload({ sessionId: 's1' }))
    pool.handle(m.model, payload({ sessionId: 's1' }))
    expect(m.openSession).toHaveBeenCalledTimes(1)
  })
})
