import { describe, expect, it } from 'vitest'
import { OnnxModel } from '../src/core/native-asr'
import { MODEL_DIR, feedAll, has, wavInt16 } from './helpers/wav'

const ASR_DIR = 'asr-zh-en-2025'
const ZH_WAV = MODEL_DIR + '/' + ASR_DIR + '/test_wavs/zh.wav'
const EN_WAV = MODEL_DIR + '/' + ASR_DIR + '/test_wavs/en.wav'

describe.skipIf(!has(ZH_WAV) || !has(EN_WAV))('bilingual ASR smoke (asr-zh-en-2025)', () => {
  async function recognize(int16: Int16Array): Promise<string> {
    const model = new OnnxModel({ modelDir: MODEL_DIR, asrDir: ASR_DIR })
    await model.start()
    const session = model.openSession()
    if (session === null) throw new Error('openSession 失败')
    return feedAll(session, int16).finals.join('')
  }

  it('中文 wav 出中文', async () => {
    const text = await recognize(wavInt16(ZH_WAV))
    expect(/[一-鿿]/.test(text)).toBe(true)
  }, 120000)

  it('英文 wav 出英文', async () => {
    const text = await recognize(wavInt16(EN_WAV))
    expect(/[a-zA-Z]/.test(text)).toBe(true)
  }, 120000)
})
