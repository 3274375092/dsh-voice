import { describe, expect, it } from 'vitest'
import { RpcRecognizer } from '../src/core/asr'
import type { AsrRpc } from '../src/core/asr'

/** 假 host:固定应答序列,记录收到的分块。 */
function fakeRpc(responses: Array<{ delta: string; final: boolean }>) {
  const received: Array<{ audio: string; final: boolean }> = []
  const rpc: AsrRpc = {
    async callAsr(payload) {
      received.push({ audio: payload.audio, final: payload.final })
      const next = responses.shift()
      if (next === undefined) throw new Error('no more responses')
      return next
    },
  }
  return { rpc, received }
}

describe('RpcRecognizer(client 半 → host ASR)', () => {
  it('分块推送到 host,增量文本经 onText 回传', async () => {
    const { rpc, received } = fakeRpc([
      { delta: '你好', final: false },
      { delta: '世界', final: true },
    ])
    const rec = new RpcRecognizer(rpc, 'sess-1')
    const texts: string[] = []
    rec.onText((text) => { texts.push(text) })
    await rec.start()
    await rec.pushChunk('AAAA', false)
    await rec.pushChunk('BBBB', true)
    expect(received).toEqual([
      { audio: 'AAAA', final: false },
      { audio: 'BBBB', final: true },
    ])
    expect(texts).toEqual(['你好', '世界'])
  })

  it('stop 后不再推送', async () => {
    const { rpc, received } = fakeRpc([{ delta: 'x', final: false }])
    const rec = new RpcRecognizer(rpc, 'sess-1')
    await rec.start()
    rec.stop()
    await rec.pushChunk('AAAA', false)
    expect(received).toEqual([])
  })

  it('host 报错 → onError', async () => {
    const rpc: AsrRpc = {
      async callAsr() { throw new Error('host down') },
    }
    const rec = new RpcRecognizer(rpc, 'sess-1')
    const errors: string[] = []
    rec.onError((err) => { errors.push(err.message) })
    await rec.start()
    await rec.pushChunk('AAAA', false)
    expect(errors).toEqual(['host down'])
  })
})
