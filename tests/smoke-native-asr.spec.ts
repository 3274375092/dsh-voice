import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OnnxRecognizer } from '../src/core/native-asr'

const MODEL_DIR = 'D:/code/voxelf/assets/models'
const TEST_WAV = 'D:/code/voxelf/assets/models/asr-zh/test.wav'

describe.skipIf(!existsSync(MODEL_DIR) || !existsSync(TEST_WAV))('native ASR smoke', () => {
  it('识别 asr-zh/test.wav 输出中文(含流式 partial)', async () => {
    const buf = readFileSync(TEST_WAV)
    const data = buf.subarray(44)
    const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
    const rec = new OnnxRecognizer({ modelDir: MODEL_DIR })
    await rec.start()
    const finals: string[] = []
    const partials: string[] = []
    rec.onText((text) => { finals.push(text) })
    const CHUNK = 3200
    for (let i = 0; i < int16.length; i += CHUNK) {
      const out = rec.feed(int16.subarray(i, Math.min(i + CHUNK, int16.length)), false)
      if (out.partial !== '') partials.push(out.partial)
    }
    const lastOut = rec.feed(new Int16Array(0), true)
    const joined = finals.join('')
    expect(joined.length).toBeGreaterThan(0)
    expect(/[\u4e00-\u9fff]/.test(joined)).toBe(true)
    expect(joined.startsWith('我做了介绍')).toBe(true) // 句首音不得被吞(预滚回归防线)
    // 流式特性:说话过程中应有 partial(若 wav 无中途静音,partial 至少出现一次)
    expect(partials.length + lastOut.partial.length).toBeGreaterThan(0)
  }, 120000)
})
