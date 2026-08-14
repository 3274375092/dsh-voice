// 双语模型线上验证:en.wav + zh.wav 走 /voice.asr 通道
const fs = require('fs')
async function rpc(method, payload, channel) {
  const res = await fetch('http://127.0.0.1:3180/' + channel + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'bi-' + Math.random(), method, payload }),
  })
  return res.json()
}
function wavInt16(p) {
  const buf = fs.readFileSync(p)
  const data = buf.subarray(44)
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
}
function toB64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return Buffer.from(bin, 'binary').toString('base64')
}
async function recognize(label, wavPath) {
  const created = await rpc('session.create', { cwd: 'D:/code/deepseek-harness' }, 'api')
  const sessionId = created.result.value.sessionId
  const int16 = wavInt16(wavPath)
  const CHUNK = 3200
  let text = ''
  for (let i = 0; i < int16.length; i += CHUNK) {
    const res = await rpc('asr', { sessionId, audio: toB64(int16.subarray(i, Math.min(i + CHUNK, int16.length))), final: false }, 'voice')
    if (res.result.ok && res.result.value.delta) text += res.result.value.delta
  }
  const last = await rpc('asr', { sessionId, audio: '', final: true }, 'voice')
  if (last.result.ok && last.result.value.delta) text += last.result.value.delta
  console.log(label + ':', JSON.stringify(text))
}
;(async () => {
  await recognize('EN', 'D:/code/voxelf/assets/models/asr-zh-en-2025/test_wavs/en.wav')
  await recognize('ZH', 'D:/code/voxelf/assets/models/asr-zh-en-2025/test_wavs/zh.wav')
})().catch(err => { console.error('ERR', err); process.exit(1) })
