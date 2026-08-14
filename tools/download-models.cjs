#!/usr/bin/env node
// dsh-voice 模型下载:zipformer2 中文流式 ASR + silero VAD(约 100MB)。
// 来源: hf-mirror.com(voxelf 同源,gitee/github 直连受阻网络的可用镜像)。
// 用法:
//   dsh-voice-models                  # 下载到 ./dsh-voice-models
//   dsh-voice-models D:/models/voice  # 指定目录
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const MIRROR = 'https://hf-mirror.com'
const out = process.argv[2] || path.join(process.cwd(), 'dsh-voice-models')
const JOBS = [
  {
    name: 'ASR zipformer2 zh(int8, 2025-06-30,与 voxelf asr-zh 同源)',
    base: MIRROR + '/csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30/resolve/main/',
    files: ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    dest: path.join(out, 'asr-zh'),
  },
  {
    name: 'VAD silero',
    base: MIRROR + '/csukuangfj/vad/resolve/main/',
    files: ['silero_vad.onnx'],
    dest: path.join(out, 'vad'),
  },
]

let failed = 0
for (const job of JOBS) {
  fs.mkdirSync(job.dest, { recursive: true })
  for (const f of job.files) {
    const destPath = path.join(job.dest, f)
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      console.log('[skip]', destPath)
      continue
    }
    const tmp = destPath + '.part'
    const cmd = 'curl -sL --retry 5 --retry-delay 3 --max-time 900 -o "' + tmp + '" "' + job.base + f + '"'
    console.log('[get]', job.name, '→', f)
    try {
      execSync(cmd, { stdio: 'inherit' })
      fs.renameSync(tmp, destPath)
    } catch (err) {
      failed += 1
      console.error('[FAIL]', f, String(err).slice(0, 200))
    }
  }
}
if (failed > 0) {
  console.error('\n部分下载失败(网络?),重跑本命令续传。')
  process.exit(1)
}
console.log('\nDONE →', out)
console.log('在 profile 的 cordis.patch.yml 里配置:')
console.log('  - id: voice')
console.log('    config:')
console.log('      modelDir: "' + out.replace(/\\/g, '/') + '"')
