import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OnnxRecognizer } from '../src/core/native-asr'

const MODEL_DIR = 'D:/code/voxelf/assets/models'
const ASR_DIR = 'asr-zh-en-2025'
const ZH_WAV = MODEL_DIR + '/' + ASR_DIR + '/test_wavs/zh.wav'
const EN_WAV = MODEL_DIR + '/' + ASR_DIR + '/test_wavs/en.wav'

describe.skipIf(!existsSync(ZH_WAV) || !existsSync(EN_WAV))('bilingual ASR smoke (asr-zh-en-2025)', () => {
  function wavInt16(path: string): Int16Array {
    const buf = readFileSync(path)
    const data = buf.subarray(44)
    return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
  }

  async function recognize(rec: OnnxRecognizer, int16: Int16Array): Promise<string> {
    const texts: string[] = []
    rec.onText((text) => { texts.push(text) })
    const CHUNK = 3200
    for (let i = 0; i < int16.length; i += CHUNK) {
      rec.feed(int16.subarray(i, Math.min(i + CHUNK, int16.length)), false)
    }
    rec.feed(new Int16Array(0), true)
    return texts.join('')
  }

  it('中文 wav 出中文', async () => {
    const rec = new OnnxRecognizer({ modelDir: MODEL_DIR, asrDir: ASR_DIR })
    await rec.start()
    const text = await recognize(rec, wavInt16(ZH_WAV))
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(true)
  }, 120000)

  it('英文 wav 出英文', async () => {
    const rec = new OnnxRecognizer({ modelDir: MODEL_DIR, asrDir: ASR_DIR })
    await rec.start()
    const text = await recognize(rec, wavInt16(EN_WAV))
    expect(/[a-zA-Z]/.test(text)).toBe(true)
  }, 120000)
})
