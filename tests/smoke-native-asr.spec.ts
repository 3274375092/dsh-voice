import { describe, expect, it } from 'vitest'
import { OnnxModel } from '../src/core/native-asr'
import { MODEL_DIR, TEST_WAV, feedAll, has, wavInt16 } from './helpers/wav'

describe.skipIf(!has(MODEL_DIR) || !has(TEST_WAV))('native ASR smoke', () => {
  it('识别 asr-zh/test.wav 输出中文(含流式 partial)', async () => {
    const model = new OnnxModel({ modelDir: MODEL_DIR })
    await model.start()
    const session = model.openSession()
    if (session === null) throw new Error('openSession 失败')
    const { partials, finals } = feedAll(session, wavInt16(TEST_WAV))
    const joined = finals.join('')
    expect(joined.length).toBeGreaterThan(0)
    expect(/[一-鿿]/.test(joined)).toBe(true)
    expect(joined.startsWith('我做了介绍')).toBe(true) // 句首音不得被吞(预滚回归防线)
    // 流式特性:说话过程中应有 partial(若 wav 无中途静音,partial 至少出现一次)
    expect(partials.length).toBeGreaterThan(0)
  }, 120000)
})
