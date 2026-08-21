#!/usr/bin/env node
/**
 * 发布包校验(issue #2 的建议测试落地)。
 *
 * 断言三件事:
 *  1. `npm pack --ignore-scripts` 打出的 tarball 与清单里声明的运行时产物一致
 *     (lib/index.js、lib/client.js、类型声明、cordis.patch.yml、模型下载器)。
 *  2. 打包清单不含任何安装期生命周期脚本(prepare/preinstall/install/postinstall);
 *     构建只允许在发布方侧发生(prepack)。
 *  3. 以 `--ignore-scripts` 把 tarball 装进临时目录后,插件 host 半仍可被
 *     import —— 即 DSH 安装路径在脚本被禁用时依然完整可用。
 *
 * 用法: node scripts/verify-package.cjs(在 CI 与 release workflow 中调用)
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PKG = require(path.join(ROOT, 'package.json'))

/** 消费者安装后必须存在的运行时文件 */
const REQUIRED_FILES = [
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/client/index.d.ts',
  'cordis.patch.yml',
  'tools/download-models.cjs',
]
/** 打包时不允许出现的路径(源码不进发布包) */
const FORBIDDEN_SUFFIXES = ['.ts', '.tsx']

let failed = false
function ok(msg) { console.log(`  ✓ ${msg}`) }
function fail(msg) { console.error(`  ✗ ${msg}`); failed = true }

/** Windows 上 spawn .cmd 需要 shell:true(Node ≥ 20.12 限制) */
function runNpm(args, opts = {}) {
  // 模拟干净消费者环境:父进程泄漏的 npm_config_allow_scripts 会让 npm 12
  // 在项目安装里抛 EALLOWSCRIPTS(该策略只应来自消费者自己的配置)。
  const env = { ...process.env }
  delete env.npm_config_allow_scripts
  const res = spawnSync(NPM, args, { ...opts, shell: process.platform === 'win32', env })
  if (res.error) throw res.error
  return res
}

// ---------- 1. pack(禁用所有生命周期脚本) ----------
console.log(`[1/3] npm pack --ignore-scripts(${PKG.name}@${PKG.version})...`)
let packInfo
let tarball = null
try {
  const res = runNpm(['pack', '--ignore-scripts', '--json'], { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(res.stderr || res.stdout || `exit ${res.status}`)
  const parsed = JSON.parse(res.stdout)
  // npm 12: {"<name>": {filename, files, ...}}; npm ≤11: [{filename, files, ...}]
  packInfo = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  tarball = path.join(ROOT, packInfo.filename)
} catch (err) {
  fail(`npm pack 失败: ${err.message}`)
  process.exit(1)
}
if (!packInfo || !packInfo.filename || !Array.isArray(packInfo.files)) {
  fail('npm pack --json 输出缺少 filename/files')
  process.exit(1)
}

// npm 12: files 为 {path,size,mode} 对象数组;npm ≤11:字符串数组
const packed = packInfo.files.map((f) => (typeof f === 'string' ? f : f.path))
ok(`tarball ${packInfo.filename}(${packed.length} files)`)

// ---------- 2. 直接从 tarball 读打包清单与文件 ----------
console.log('[2/3] 检查打包清单(无安装期脚本)与产物完整性...')

/** 极简 tar 读取器(npm tarball = gzip + ustar;不依赖系统 tar) */
function readTarEntries(buf) {
  const entries = new Map()
  const readStr = (base, off, len) => {
    let end = off
    while (end < off + len && base[end] !== 0) end++
    return base.subarray(off, end).toString('utf8')
  }
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const name = readStr(header, 0, 100)
    const size = parseInt(readStr(header, 124, 12).trim() || '0', 8) || 0
    const prefix = readStr(header, 345, 155)
    const full = prefix ? `${prefix}/${name}` : name
    const dataStart = off + 512
    if (!entries.has(full)) entries.set(full, buf.subarray(dataStart, dataStart + size))
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

let entries
let manifest
try {
  entries = readTarEntries(zlib.gunzipSync(fs.readFileSync(tarball)))
  manifest = JSON.parse(entries.get('package/package.json').toString('utf8'))
} catch (err) {
  fail(`无法解析 tarball: ${err.message}`)
  process.exit(1)
}

// 2a. 产物完整性:清单与真实 tarball 都要包含运行时文件
for (const f of REQUIRED_FILES) {
  if (!packed.includes(f)) fail(`打包清单缺少 ${f}`)
  if (!entries.has(`package/${f}`)) fail(`tarball 缺少 ${f}`)
}
// 2b. 源码不进发布包(.d.ts 类型声明除外)
const leaked = packed.filter((f) =>
  FORBIDDEN_SUFFIXES.some((s) => f.endsWith(s) && !f.endsWith('.d.ts')),
)
if (leaked.length > 0) fail(`发布包包含源码文件: ${leaked.join(', ')}`)

// 2c. 无安装期脚本;构建只允许在发布方侧(prepack)
const INSTALL_TIME_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']
for (const s of INSTALL_TIME_SCRIPTS) {
  if (manifest.scripts && manifest.scripts[s]) fail(`打包清单含安装期脚本 ${s}: ${manifest.scripts[s]}`)
}
if (!manifest.scripts || manifest.scripts.prepack !== 'npm run build') {
  fail('打包清单缺少 prepack: npm run build(构建必须发生在发布方侧)')
}
if (failed) process.exit(1)
ok('打包清单: 无 prepare/preinstall/install/postinstall,prepack 为唯一构建入口')
ok(`运行时产物完整(${REQUIRED_FILES.length} 项),无源码泄漏`)

// ---------- 3. 消费者模拟:禁用脚本安装 + DSH 加载路径 ----------
console.log('[3/3] 模拟消费者安装(--ignore-scripts)并验证加载路径...')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-verify-'))
try {
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'dsh-voice-verify-tmp', private: true, version: '0.0.0' }),
  )
  const install = runNpm(['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: tmp,
    encoding: 'utf8',
  })
  if (install.status !== 0) {
    fail(`禁用脚本安装失败: ${install.stderr || install.stdout}`)
    process.exit(1)
  }
  const installedRoot = path.join(tmp, 'node_modules', PKG.name)
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(installedRoot, f))) fail(`安装产物缺少 ${f}`)
  }
  const load = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('@nn12138/dsh-voice'); console.log('LOAD_OK')"],
    { cwd: tmp, encoding: 'utf8' },
  )
  if (load.status !== 0 || !load.stdout.includes('LOAD_OK')) {
    fail(`DSH 加载路径失败: ${load.stderr || load.stdout}`)
    process.exit(1)
  }
  ok(`--ignore-scripts 安装成功,host 半可被 import(${installedRoot})`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (tarball && fs.existsSync(tarball)) fs.rmSync(tarball, { force: true })
}

if (failed) process.exit(1)
console.log(`\n发布包校验通过:${PKG.name}@${PKG.version} 无安装期脚本,产物完整,脚本禁用下可安装加载。`)
