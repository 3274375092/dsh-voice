// tools 共享工具:WAV → Int16、base64 分块(线协议冒烟脚本共用,消除重复)。
const fs = require('fs')

/** WAV → Int16(跳过 44 字节 RIFF 头)。 */
function wavInt16(path) {
  const buf = fs.readFileSync(path)
  const data = buf.subarray(44)
  return new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
}

/** Int16 → base64(分片避开 String.fromCharCode 栈限制)。 */
function toB64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH))
  return Buffer.from(bin, 'binary').toString('base64')
}

module.exports = { wavInt16, toB64 }
