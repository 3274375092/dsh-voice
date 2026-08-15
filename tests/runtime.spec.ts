import { describe, expect, it, vi } from 'vitest'
import { VoiceRuntime } from '../src/client/runtime'
import type { SpeechRecognizer } from '../src/core/asr'

/** 可控假识别器:手动触发 onText/onError;记录 stop/pushChunk 调用。 */
function fakeRecognizer() {
  let textCb: (delta: string, final: boolean) => void = () => {}
  let errorCb: (err: Error) => void = () => {}
  const calls = { start: 0, stop: 0, chunks: [] as Array<{ audio: string; final: boolean }> }
  const rec = {
    async start(): Promise<void> { calls.start += 1 },
    stop(): void { calls.stop += 1 },
    onText(cb: (delta: string, final: boolean) => void): () => void { textCb = cb; return () => {} },
    onError(cb: (err: Error) => void): () => void { errorCb = cb; return () => {} },
    async pushChunk(audio: string, final: boolean): Promise<void> { calls.chunks.push({ audio, final }) },
    emitText: (delta: string, final: boolean) => { textCb(delta, final) },
    emitError: (err: Error) => { errorCb(err) },
  }
  return { rec, calls }
}

function makeRuntime(engine: 'browser' | 'native') {
  const f = fakeRecognizer()
  const submitted: string[] = []
  const sent: Array<{ sessionId: string; text: string }> = []
  const runtime = new VoiceRuntime({} as never, { engine }, {
    createRecognizer: () => f.rec as SpeechRecognizer,
    capture: async () => ({ stop: vi.fn() }),
    submit: async (sessionId, text) => { submitted.push(text); sent.push({ sessionId, text }) },
    finalizeTimeoutMs: 50,
  })
  return { runtime, submitted, sent, f }
}

function makeAutoRuntime(pingNative: boolean) {
  const f = fakeRecognizer()
  const ping = vi.fn(async () => ({ ok: true, value: { ok: true, native: pingNative } }))
  const ctx = { connection: { rpc: { call: ping } } }
  const runtime = new VoiceRuntime(ctx as never, { engine: 'auto' }, {
    createRecognizer: () => f.rec as SpeechRecognizer,
    capture: async () => ({ stop: vi.fn() }),
    submit: async () => {},
    finalizeTimeoutMs: 50,
  })
  return { runtime, ping }
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('VoiceRuntime(定稿语义 + 停麦竞态)', () => {
  it('浏览器手动停麦:迟到的 final 只提交一次(双提交竞态回归)', async () => {
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('你好世', false) // interim 部分识别
    const stopping = runtime.stopMic('s1') // 用户点停:等待 final
    f.rec.emitText('你好世界', true) // stop() 触发的异步 final 定稿
    await stopping
    await flush()
    expect(submitted).toEqual(['你好世界'])
  })

  it('浏览器自然定稿:final 到达自动停麦并提交一次', async () => {
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('部分', false)
    f.rec.emitText('完整句子', true)
    await flush()
    expect(submitted).toEqual(['完整句子'])
    expect(runtime.isListening()).toBe(false)
  })

  it('浏览器停麦无 final:超时后提交 partial,迟到回调作废', async () => {
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('说到一半', false)
    await runtime.stopMic('s1') // 50ms 超时 → 提交 partial
    f.rec.emitText('完整句子', true) // 迟到的 final:轮次守卫丢弃
    await flush()
    expect(submitted).toEqual(['说到一半'])
  })

  it('native 停麦:发 final 空块冲刷 host 并提交累计定稿', async () => {
    const { runtime, submitted, f } = makeRuntime('native')
    await runtime.toggleMic('s1')
    f.rec.emitText('你好世界', true) // 定稿全文(替换式)
    await runtime.stopMic('s1')
    expect(f.calls.chunks).toContainEqual({ audio: '', final: true })
    expect(submitted).toEqual(['你好世界'])
  })

  it('native 停麦后迟到的 final 被丢弃', async () => {
    const { runtime, submitted, f } = makeRuntime('native')
    await runtime.toggleMic('s1')
    await runtime.stopMic('s1')
    f.rec.emitText('迟到', true)
    await flush()
    expect(submitted).toEqual([])
  })

  it('跨会话点停:文本提交给开启本轮识别的会话', async () => {
    const { runtime, sent, f } = makeRuntime('native')
    await runtime.toggleMic('s1')
    f.rec.emitText('第一段', true)
    await runtime.toggleMic('s2') // 另一会话点停 → 停掉 s1 的轮,提交仍归 s1
    expect(runtime.isListening()).toBe(false)
    expect(sent).toEqual([{ sessionId: 's1', text: '第一段' }])
  })
})

describe('VoiceRuntime(auto 引擎探测与零配置兜底)', () => {
  it('ping 返回 native:false → 使用浏览器识别', async () => {
    const { runtime, ping } = makeAutoRuntime(false)
    await expect(runtime.getEngine()).resolves.toBe('browser')
    expect(ping).toHaveBeenCalledWith('/voice', 'ping', {})
  })

  it('ping 返回 native:true → 使用原生识别', async () => {
    const { runtime, ping } = makeAutoRuntime(true)
    await expect(runtime.getEngine()).resolves.toBe('native')
    expect(ping).toHaveBeenCalledWith('/voice', 'ping', {})
  })
})
