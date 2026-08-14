// 双语模型线上验证:en.wav + zh.wav 走 /voice.asr 通道
const { wavInt16, toB64 } = require('./lib.cjs')
const PORT = process.env.PORT || '3180'
const MODEL_DIR = process.env.DSH_VOICE_MODEL_DIR || 'D:/code/voxelf/assets/models'
async function rpc(method, payload, channel) {
  const res = await fetch('http://127.0.0.1:' + PORT + '/' + channel + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'bi-' + Math.random(), method, payload }),
  })
  return res.json()
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
  await recognize('EN', MODEL_DIR + '/asr-zh-en-2025/test_wavs/en.wav')
  await recognize('ZH', MODEL_DIR + '/asr-zh-en-2025/test_wavs/zh.wav')
})().catch(err => { console.error('ERR', err); process.exit(1) })
