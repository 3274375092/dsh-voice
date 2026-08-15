import { describe, expect, it, vi } from 'vitest'
import { NativeRecognizer } from '../src/client/asr'
import { encodeBase64 } from '../src/client/audio'
import type { AsrChunkPayload, AsrChunkResponse } from '../src/types'

function decodeInt16(b64: string): Int16Array {
  const bin = atob(b64)
  const out = new Int16Array(bin.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16
  }
  return out
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

interface NativeHarness {
  rec: NativeRecognizer
  push: (int16: Int16Array) => void
  stop: ReturnType<typeof vi.fn>
  callAsr: ReturnType<typeof vi.fn>
  texts: Array<{ text: string; final: boolean }>
  errors: Error[]
}

/** 假采声 + 假 callAsr;onChunk 可经 push 手动驱动。 */
function makeNative(
  callAsrImpl?: (payload: AsrChunkPayload) => Promise<AsrChunkResponse>,
): NativeHarness {
  let chunkCb: ((int16: Int16Array) => void) | null = null
  const stop = vi.fn()
  const capture = vi.fn(async (cb: (int16: Int16Array) => void) => {
    chunkCb = cb
    return { stop }
  })
  const callAsr = vi.fn(callAsrImpl ?? (async (payload: AsrChunkPayload): Promise<AsrChunkResponse> => {
    if (payload.final) return { delta: '', final: true }
    return { delta: '部分', final: false }
  }))
  const texts: Array<{ text: string; final: boolean }> = []
  const errors: Error[] = []
  const rec = new NativeRecognizer({ sessionId: 's1', callAsr, capture })
  rec.onText((text, final) => { texts.push({ text, final }) })
  rec.onError((err) => { errors.push(err) })
  return {
    rec,
    push: (int16) => chunkCb?.(int16),
    stop,
    callAsr,
    texts,
    errors,
  }
}

describe('NativeRecognizer(采声 → 编码 → 推送全链路)', () => {
  it('start 后采声启动;推入的 Int16 被编码为 base64 分块送达 host', async () => {
    const m = makeNative()
    await m.rec.start()
    m.push(new Int16Array([1000, -2000, 300]))
    await flush()
    expect(m.callAsr).toHaveBeenCalledTimes(1)
    const payload = m.callAsr.mock.calls[0]![0] as AsrChunkPayload
    expect(payload.sessionId).toBe('s1')
    expect(payload.final).toBe(false)
    expect(Array.from(decodeInt16(payload.audio))).toEqual([1000, -2000, 300])
  })

  it('替换式定稿:final 分段累计成全文,partial 直接透传', async () => {
    const m = makeNative(async (payload) => {
      if (payload.audio === encodeBase64(new Int16Array([1]))) return { delta: '你', final: false }
      if (payload.audio === encodeBase64(new Int16Array([2]))) return { delta: '好', final: true }
      return { delta: '世界', final: true }
    })
    await m.rec.start()
    m.push(new Int16Array([1]))
    m.push(new Int16Array([2]))
    m.push(new Int16Array([3]))
    await flush()
    expect(m.texts).toEqual([
      { text: '你', final: false },
      { text: '好', final: true },
      { text: '好世界', final: true },
    ])
  })

  it('stop 发空块冲刷并挂在推送链尾;幂等', async () => {
    const m = makeNative()
    await m.rec.start()
    m.push(new Int16Array([5]))
    await m.rec.stop()
    const calls = m.callAsr.mock.calls.map((c) => c[0] as AsrChunkPayload)
    expect(calls[calls.length - 1]).toMatchObject({ audio: '', final: true })
    expect(m.stop).toHaveBeenCalledTimes(1) // 采声已释放
    await m.rec.stop() // 幂等:不重复冲刷
    expect(m.callAsr.mock.calls.length).toBe(2) // 1 块 + 1 冲刷
  })

  it('串行化:前一块未完成时,后一块不发出', async () => {
    const order: number[] = []
    let releaseA!: () => void
    const callAsrImpl = (payload: AsrChunkPayload) => new Promise<AsrChunkResponse>((resolve) => {
      const key = decodeInt16(payload.audio)[0] ?? 0
      order.push(key)
      if (key === 1) {
        releaseA = () => resolve({ delta: '', final: false })
      } else {
        resolve({ delta: '', final: payload.final })
      }
    })
    const m = makeNative(callAsrImpl)
    await m.rec.start()
    m.push(new Int16Array([1])) // 在途
    m.push(new Int16Array([2])) // 排队
    await flush()
    expect(order).toEqual([1]) // 2 未发出:等 1 完成
    releaseA()
    await flush()
    expect(order).toEqual([1, 2])
  })

  it('单块 RPC 失败在内部吸收:不发出 onError,后续分块继续', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = makeNative(async (payload) => {
      if (payload.audio === encodeBase64(new Int16Array([1]))) throw new Error('boom')
      return { delta: '好', final: true }
    })
    await m.rec.start()
    m.push(new Int16Array([1])) // 失败块
    m.push(new Int16Array([2])) // 后续块
    await flush()
    expect(m.errors).toEqual([])
    expect(m.texts).toEqual([{ text: '好', final: true }])
    errSpy.mockRestore()
  })

  it('stop 后不再推送任何分块', async () => {
    const m = makeNative()
    await m.rec.start()
    await m.rec.stop()
    const before = m.callAsr.mock.calls.length
    m.push(new Int16Array([9]))
    await flush()
    expect(m.callAsr.mock.calls.length).toBe(before)
  })

  it('采声失败 → start() reject', async () => {
    const capture = vi.fn(async () => { throw new Error('mic denied') })
    const rec = new NativeRecognizer({
      sessionId: 's1',
      callAsr: vi.fn(),
      capture,
    })
    await expect(rec.start()).rejects.toThrow('mic denied')
  })

  it('start 期间被 stop:采声立即释放,只发冲刷不推音频', async () => {
    let resolveCapture!: (c: { stop: () => void }) => void
    const stopFn = vi.fn()
    const capture = vi.fn((_cb: (int16: Int16Array) => void) => new Promise<{ stop: () => void }>((resolve) => {
      resolveCapture = resolve
    }))
    const callAsr = vi.fn(async (): Promise<AsrChunkResponse> => ({ delta: '', final: true }))
    const rec = new NativeRecognizer({ sessionId: 's1', callAsr, capture })
    const startP = rec.start()
    const stopP = rec.stop()
    resolveCapture({ stop: stopFn })
    await startP
    await stopP
    expect(stopFn).toHaveBeenCalled() // 采声被立即停止
    expect(callAsr).toHaveBeenCalledTimes(1)
    expect(callAsr.mock.calls[0]![0]).toMatchObject({ audio: '', final: true })
  })
})
