/**
 * 音频采集与编解码(纯函数 + 浏览器采集;零依赖,可单测)。
 */

/** 识别要求的采样率(host VAD/ASR 的输入约定)。 */
export const ASR_SAMPLE_RATE = 16000

/** 麦克风采集句柄(stop 幂等)。 */
export interface MicCapture {
  stop(): void
}

/** 采集麦克风 PCM(Int16 16kHz 单声道)。
 * MicCapture seam 由两个 adapter 支撑:生产(ScriptProcessor)+ 测试替身
 * (测试注入 capture)——两 adapter 即成真 seam。 */
export async function capturePcm(onChunk: (int16: Int16Array) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: ASR_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const actx = new AudioContext({ sampleRate: ASR_SAMPLE_RATE })
  // 部分浏览器忽略采样率请求:按实际率线性重采样到 16k,保证 host 端 VAD/ASR 输入正确
  const contextRate = actx.sampleRate
  const source = actx.createMediaStreamSource(stream)
  const processor = actx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const resampled = contextRate === ASR_SAMPLE_RATE
      ? input
      : linearResample(input, contextRate, ASR_SAMPLE_RATE)
    onChunk(floatToInt16(resampled))
  }
  source.connect(processor)
  processor.connect(actx.destination)
  return {
    stop(): void {
      try {
        processor.disconnect()
        source.disconnect()
        void actx.close()
      } catch {
        // 幂等
      }
      for (const track of stream.getTracks()) track.stop()
    },
  }
}

/** Float32 → Int16(限幅)。 */
export function floatToInt16(input: Float32Array): Int16Array {
  const int16 = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

/** 线性插值重采样(仅当浏览器实际采样率 ≠ 16k 时使用)。 */
export function linearResample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = toRate / fromRate
  const outLen = Math.round(input.length * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i += 1) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = src - i0
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac
  }
  return out
}

/** Int16 PCM → base64(分片避开 String.fromCharCode 栈限制)。 */
export function encodeBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
