const fs = require('fs')
const WAV = 'D:/code/voxelf/assets/models/asr-zh/test.wav'
const buf = fs.readFileSync(WAV)
const data = buf.subarray(44)
const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))

async function rpc(method, payload, channel) {
  const res = await fetch('http://127.0.0.1:' + (process.env.PORT || '3180') + '/' + channel + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'asr-' + Math.random(), method, payload }),
  })
  return res.json()
}
function toB64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return Buffer.from(bin, 'binary').toString('base64')
}
;(async () => {
  const created = await rpc('session.create', { cwd: 'D:/code/deepseek-harness' }, 'api')
  const sessionId = created.result.value.sessionId
  const CHUNK = 3200
  // 第一个分块:完整响应
  const first = await rpc('asr', { sessionId, audio: toB64(int16.subarray(0, CHUNK)), final: false }, 'voice')
  console.log('FIRST RESP:', JSON.stringify(first))
  // 全量喂入(中间块)
  let totalDelta = ''
  for (let i = CHUNK; i < int16.length; i += CHUNK) {
    const res = await rpc('asr', { sessionId, audio: toB64(int16.subarray(i, Math.min(i + CHUNK, int16.length))), final: false }, 'voice')
    if (res.result?.ok && res.result.value.delta) totalDelta += res.result.value.delta
  }
  const last = await rpc('asr', { sessionId, audio: '', final: true }, 'voice')
  console.log('MID DELTA:', JSON.stringify(totalDelta))
  console.log('LAST RESP:', JSON.stringify(last))
})().catch(err => { console.error('ERR', err); process.exit(1) })
