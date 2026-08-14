import { describe, expect, it } from 'vitest'
import { OnnxModel } from '../src/core/native-asr'
import { DOWNLOADED_MODELS, TEST_WAV, feedAll, has, wavInt16 } from './helpers/wav'

describe.skipIf(!has(DOWNLOADED_MODELS) || !has(TEST_WAV))('downloaded models smoke', () => {
  it('下载的模型可识别中文', async () => {
    const model = new OnnxModel({ modelDir: DOWNLOADED_MODELS })
    await model.start()
    const session = model.openSession()
    if (session === null) throw new Error('openSession 失败')
    const { finals } = feedAll(session, wavInt16(TEST_WAV))
    const joined = finals.join('')
    console.log('识别:', joined)
    expect(/[一-鿿]/.test(joined)).toBe(true)
  }, 120000)
})
