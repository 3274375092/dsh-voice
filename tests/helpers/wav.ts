import { existsSync, readFileSync } from 'node:fs'

/** 烟测路径:默认指向本机 voxelf assets;用环境变量指到别处(CI/他机)。 */
export const MODEL_DIR = process.env.DSH_VOICE_MODEL_DIR ?? 'D:/code/voxelf/assets/models'
export const TEST_WAV = process.env.DSH_VOICE_TEST_WAV ?? 'D:/code/voxelf/assets/models/asr-zh/test.wav'
export const DOWNLOADED_MODELS = process.env.DSH_VOICE_DOWNLOADED_MODELS ?? 'D:/code/dsh-voice-models-test'

export function has(path: string): boolean {
  return existsSync(path)
}

/** WAV → Int16(跳过 44 字节 RIFF 头;三个烟测共用)。 */
export function wavInt16(path: string): Int16Array {
  const buf = readFileSync(path)
  const data = buf.subarray(44)
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
}

/** 整段音频按线上节奏分块喂入 + final 冲刷;返回全部 partial 与 finals。 */
export function feedAll(
  rec: { feed(int16: Int16Array, final: boolean): { partial: string; finals: string[] } },
  int16: Int16Array,
): { partials: string[]; finals: string[] } {
  const partials: string[] = []
  const finals: string[] = []
  const CHUNK = 3200
  for (let i = 0; i < int16.length; i += CHUNK) {
    const out = rec.feed(int16.subarray(i, Math.min(i + CHUNK, int16.length)), false)
    finals.push(...out.finals)
    if (out.partial !== '') partials.push(out.partial)
  }
  const last = rec.feed(new Int16Array(0), true)
  finals.push(...last.finals)
  if (last.partial !== '') partials.push(last.partial)
  return { partials, finals }
}
