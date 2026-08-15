import { describe, expect, it } from 'vitest'
import { encodeBase64, floatToInt16, linearResample } from '../src/client/audio'

function decodeInt16(b64: string): Int16Array {
  const bin = atob(b64)
  const out = new Int16Array(bin.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16
  }
  return out
}

describe('floatToInt16(限幅)', () => {
  it('边界、零值与超界截断', () => {
    const out = floatToInt16(new Float32Array([-1, 1, 0, 2, -2, 0.5, -0.5]))
    expect(Array.from(out)).toEqual([-32768, 32767, 0, 32767, -32768, 16383, -16384])
  })
})

describe('linearResample(线性插值)', () => {
  it('降采样:长度与取值', () => {
    const out = linearResample(new Float32Array([1, 2, 3, 4]), 4, 2)
    expect(out.length).toBe(2)
    expect(Array.from(out)).toEqual([1, 3])
  })

  it('升采样:长度与端点保持', () => {
    const out = linearResample(new Float32Array([1, 2]), 2, 4)
    expect(out.length).toBe(4)
    expect(Array.from(out)).toEqual([1, 1.5, 2, 2])
  })
})

describe('encodeBase64(Int16 → base64)', () => {
  it('小缓冲区往返一致', () => {
    const src = new Int16Array([1, -2, 300, -32768, 32767])
    expect(Array.from(decodeInt16(encodeBase64(src)))).toEqual(Array.from(src))
  })

  it('超过单片 0x8000 字节的缓冲区(分片路径)', () => {
    const src = new Int16Array(20000) // 40000 字节 > 0x8000
    for (let i = 0; i < src.length; i += 1) src[i] = (i * 7) % 65536 - 32768
    expect(Array.from(decodeInt16(encodeBase64(src)))).toEqual(Array.from(src))
  })
})
