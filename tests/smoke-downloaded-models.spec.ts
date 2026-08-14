import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OnnxRecognizer } from '../src/core/native-asr'

const MODEL_DIR = 'D:/code/dsh-voice-models-test'
const TEST_WAV = 'D:/code/voxelf/assets/models/asr-zh/test.wav'

describe.skipIf(!existsSync(MODEL_DIR))('downloaded models smoke', () => {
  it('下载的模型可识别中文', async () => {
    const buf = readFileSync(TEST_WAV)
    const data = buf.subarray(44)
    const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
    const rec = new OnnxRecognizer({ modelDir: MODEL_DIR })
    await rec.start()
    const texts: string[] = []
    rec.onText((t) => { texts.push(t) })
    const CHUNK = 3200
    for (let i = 0; i < int16.length; i += CHUNK) rec.feed(int16.subarray(i, Math.min(i + CHUNK, int16.length)), false)
    rec.feed(new Int16Array(0), true)
    const joined = texts.join('')
    console.log('识别:', joined)
    expect(/[\u4e00-\u9fff]/.test(joined)).toBe(true)
  }, 120000)
})
