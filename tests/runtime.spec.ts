import { describe, expect, it, vi } from 'vitest'
import { VoiceRuntime } from '../src/client/runtime'
import type { SpeechRecognizer } from '../src/client/asr'
import type { VoiceService } from '../src/client/voice-service'

/** 可控假识别器:手动触发 onText/onError/onEnd;记录 start/stop。 */
function fakeRecognizer() {
  let textCb: (text: string, final: boolean) => void = () => {}
  let errorCb: (err: Error) => void = () => {}
  let endCb: () => void = () => {}
  const calls = { start: 0, stop: 0 }
  const rec = {
    async start(): Promise<void> { calls.start += 1 },
    async stop(): Promise<void> { calls.stop += 1 },
    onText(cb: (text: string, final: boolean) => void): () => void { textCb = cb; return () => {} },
    onError(cb: (err: Error) => void): () => void { errorCb = cb; return () => {} },
    onEnd(cb: () => void): () => void { endCb = cb; return () => {} },
    emitText: (text: string, final: boolean) => { textCb(text, final) },
    emitError: (err: Error) => { errorCb(err) },
    emitEnd: () => { endCb() },
  }
  return { rec, calls }
}

function makeRuntime(engine: 'browser' | 'native') {
  const f = fakeRecognizer()
  const submitted: string[] = []
  const sent: Array<{ sessionId: string; text: string }> = []
  const runtime = new VoiceRuntime({} as never, { engine }, {
    createRecognizer: () => f.rec as SpeechRecognizer,
    submit: async (sessionId, text) => { submitted.push(text); sent.push({ sessionId, text }) },
  })
  return { runtime, submitted, sent, f }
}

function makeAutoRuntime(pingEngine: 'browser' | 'native') {
  const f = fakeRecognizer()
  const ping = vi.fn(async () => ({ engine: pingEngine }))
  const rpc: VoiceService = {
    ping,
    fetchConfig: vi.fn(async () => ({ engine: 'browser', hotkey: 'ctrl+space' })),
    asr: vi.fn(async () => ({ delta: '', final: false })),
  }
  const runtime = new VoiceRuntime({} as never, { engine: 'auto' }, {
    createRecognizer: () => f.rec as SpeechRecognizer,
    submit: async () => {},
    rpc,
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
    const stopping = runtime.stopMic('s1') // 用户点停:等待 stop() 完成
    f.rec.emitText('你好世界', true) // stop() 期间迟到的 final 定稿
    await stopping
    await flush()
    expect(submitted).toEqual(['你好世界'])
  })

  it('浏览器自然定稿:onEnd 触发停麦并提交一次', async () => {
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('部分', false)
    f.rec.emitText('完整句子', true)
    f.rec.emitEnd() // 识别器自判说完
    await flush()
    expect(submitted).toEqual(['完整句子'])
    expect(runtime.isListening()).toBe(false)
  })

  it('跨会话点停:文本提交给开启本轮识别的会话', async () => {
    const { runtime, sent, f } = makeRuntime('native')
    await runtime.toggleMic('s1')
    f.rec.emitText('第一段', true)
    await runtime.toggleMic('s2') // 另一会话点停 → 停掉 s1 的轮,提交仍归 s1
    expect(runtime.isListening()).toBe(false)
    expect(sent).toEqual([{ sessionId: 's1', text: '第一段' }])
  })

  it('onError:终止本轮并丢弃文本', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('说到一半', false)
    f.rec.emitError(new Error('boom'))
    await flush()
    expect(runtime.isListening()).toBe(false)
    expect(submitted).toEqual([])
    errSpy.mockRestore()
  })

  it('停麦后迟到的回调被轮次守卫作废(不重复提交)', async () => {
    const { runtime, submitted, f } = makeRuntime('native')
    await runtime.toggleMic('s1')
    await runtime.stopMic('s1')
    f.rec.emitText('迟到', true)
    await flush()
    expect(submitted).toEqual([])
  })

  it('空轮停麦不提交', async () => {
    const { runtime, submitted } = makeRuntime('native')
    await runtime.toggleMic('s1')
    await runtime.stopMic('s1')
    await flush()
    expect(submitted).toEqual([])
  })

  it('停止进行中重复 stopMic 不重复提交', async () => {
    const { runtime, submitted, f } = makeRuntime('browser')
    await runtime.toggleMic('s1')
    f.rec.emitText('你好', true)
    const stopping = runtime.stopMic('s1')
    await runtime.stopMic('s1') // 重入:直接返回
    await stopping
    await flush()
    expect(submitted).toEqual(['你好'])
  })
})

describe('VoiceRuntime(auto 引擎探测与零配置兜底)', () => {
  it('ping 下发 browser → 使用浏览器识别', async () => {
    const { runtime, ping } = makeAutoRuntime('browser')
    await expect(runtime.getEngine()).resolves.toBe('browser')
    expect(ping).toHaveBeenCalledWith()
  })

  it('ping 下发 native → 使用原生识别', async () => {
    const { runtime, ping } = makeAutoRuntime('native')
    await expect(runtime.getEngine()).resolves.toBe('native')
    expect(ping).toHaveBeenCalledWith()
  })
})
