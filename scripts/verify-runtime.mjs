/**
 * Runtime verification: replay the real client-modules resolution contract
 * against the plugin's BUILT bundle, then drive apply() on both halves.
 *
 * This is the behavioural counterpart to scripts/verify-real-types.mjs: types
 * prove the source agrees with the shipping API, this proves the artifact
 * actually loads and runs against it.
 *
 * Run: node scripts/verify-runtime.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const bundlePath = join(repo, 'lib', 'client.js')

if (!existsSync(bundlePath)) {
  console.error('lib/client.js missing — run the build first.')
  process.exit(1)
}
const bundle = readFileSync(bundlePath, 'utf8')

// The live platform seed table (dsh-web-frontend staticModules()).
const SEED_WORDS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// ---------------------------------------------------------------- bundle load
const requireLog = []
const factories = new Map()
const seed = new Map(SEED_WORDS.map(w => [w, { __platformModule: w }]))
seed.set('@deepseek-ai/dsh-client-ui-primitives', {
  Button: props => ({ props }),
  IconStopFill16: props => ({ props }),
})
seed.set('react/jsx-runtime', { jsx: (t, p) => ({ type: t, props: p }), jsxs: (t, p) => ({ type: t, props: p }), Fragment: {} })
seed.set('react', { createElement: () => ({}) })

const loadCache = new Map()
const stripClientSuffix = s => (s.endsWith('/client') ? s.slice(0, -'/client'.length) : s)

function makeRequire() {
  return spec => {
    requireLog.push(spec)
    if (seed.has(spec)) return seed.get(spec)
    const id = stripClientSuffix(spec)
    if (loadCache.has(id)) return loadCache.get(id).exports
    if (factories.has(id)) {
      const record = { exports: factories.get(id)(makeRequire()) }
      loadCache.set(id, record)
      return record.exports
    }
    throw new Error(`require("${spec}") missed the module table (externals drift)`)
  }
}

const context = vm.createContext({
  window: { __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) } },
  console,
  document: { addEventListener: () => {}, removeEventListener: () => {} },
  setTimeout,
  clearTimeout,
})

console.log('=== client bundle: registration ===')
let regErr = null
try {
  vm.runInContext(bundle, context, { filename: 'lib/client.js' })
} catch (err) {
  regErr = err
}
check(!regErr, 'bundle registers without throwing', regErr?.message)
check(factories.has('@nn12138/dsh-voice'), 'registers under "@nn12138/dsh-voice"')

console.log('\n=== client bundle: module-table resolution ===')
let clientExports = null
let matErr = null
try {
  clientExports = factories.get('@nn12138/dsh-voice')(makeRequire())
} catch (err) {
  matErr = err
}
check(!matErr, 'factory materializes', matErr?.message)
for (const spec of [...new Set(requireLog)]) {
  check(SEED_WORDS.includes(spec), `require("${spec}") resolves against the platform table`)
}

console.log('\n=== client half: apply() ===')
check(typeof clientExports?.apply === 'function', 'exports apply()')
check(clientExports?.name === 'dsh-voice', 'exports name === "dsh-voice"')

const observed = { slotKey: null, registered: null }
const mockCtx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  effect(fn, label) { const d = fn(); return typeof d === 'function' ? d : () => {}; void label },
  connection: {
    rpc: {
      handle(channel, handler) { void channel; void handler; return async () => {} },
      call: async () => ({ ok: false, error: { code: 'probe', message: 'no host', details: {} } }),
    },
  },
  sessions: {
    list: { getSnapshot: () => ({ current: 'session-probe' }) },
    scope: () => ({ conversation: { send: async () => {} } }),
  },
  slots: {
    inject(key, cb) { observed.slotKey = key; cb(); return () => {} },
    register(options, component) {
      observed.registered = options
      const injected = options.inject('session-probe')
      check(typeof options.inject === 'function', 'slot inject is a factory function')
      check(injected.hooks?.listening?.getSnapshot() === false, 'hooks.listening starts false')
      const element = component({
        onToggle: injected.onToggle,
        useListening: s => s(injected.hooks.listening.getSnapshot()),
        usePartial: s => s(injected.hooks.partial.getSnapshot()),
        useHotkey: s => s(injected.hooks.hotkey.getSnapshot()),
        sessionId: 'session-probe',
        renderSlot: () => null,
      })
      const label = element?.props?.['aria-label'] ?? element?.type?.props?.['aria-label']
      check(typeof label === 'string' && label.length > 0, 'MicButton renders with an aria-label', label)
      return () => {}
    },
  },
}

let applyErr = null
try {
  clientExports.apply(mockCtx, { engine: 'auto', hotkey: 'ctrl+space' })
} catch (err) {
  applyErr = err
}
check(!applyErr, 'client apply() runs against the current API', applyErr?.message)
check(observed.slotKey === 'conversation.input.left', 'injects into conversation.input.left')
check(observed.registered?.name === 'conversation.input.left', 'registers name === conversation.input.left')
check(observed.registered?.id === 'voice-mic', 'registers id === voice-mic')

// ------------------------------------------------------------------ host half
console.log('\n=== host half: apply() ===')
const hostMod = await import(pathToFileURL(join(repo, 'lib', 'index.js')).href)
check(hostMod.name === 'dsh-voice-host', 'exports name === "dsh-voice-host"')
check(JSON.stringify(hostMod.inject) === '["connection"]', 'injects [connection]')

let handleArity = null
let handleChannel = null
let handlerRef = null
const hostCtx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  connection: {
    rpc: {
      // EXACT live signature (client-connection lib/index.js:543): two params.
      handle(channel, handler) { handleArity = arguments.length; handleChannel = channel; handlerRef = handler; return async () => {} },
    },
  },
}

let hostErr = null
try {
  hostMod.apply(hostCtx, {
    engine: 'auto', modelDir: '', vadThreshold: 0.3,
    tailPadSeconds: 0.6, asrDir: 'asr-zh', hotkey: 'ctrl+space',
  })
} catch (err) {
  hostErr = err
}
check(!hostErr, 'host apply() runs against the current API', hostErr?.message)
check(handleArity === 2, 'calls connection.rpc.handle() with exactly 2 args', `got ${handleArity}`)
check(handleChannel === '/voice', 'registers the /voice channel')

console.log('\n=== host half: RPC endpoints ===')
if (typeof handlerRef === 'function') {
  const ping = await handlerRef('ping', {}, new AbortController().signal)
  check(ping.ok === true, 'ping returns ok', JSON.stringify(ping.value ?? ping.error))
  check(ping.value?.engine === 'browser', 'ping falls back to browser without a model')

  const cfg = await handlerRef('config', {}, new AbortController().signal)
  check(cfg.ok === true && cfg.value?.hotkey === 'ctrl+space', 'config returns host hotkey')

  const asr = await handlerRef('asr', {}, new AbortController().signal)
  check(asr.ok === false && asr.error?.code === 'native_unavailable', 'asr reports native_unavailable')

  const bogus = await handlerRef('nope', {}, new AbortController().signal)
  check(bogus.ok === false && bogus.error?.code === 'unknown_endpoint', 'unknown endpoint is rejected')
} else {
  check(false, 'rpc handler registered')
}

console.log(`\n=== verdict ===`)
if (failures.length) {
  console.error(`FAIL (${failures.length}): ${failures.join('; ')}`)
  process.exitCode = 1
} else {
  console.log('PASS: artifact loads and both halves run against the current DSH API.')
}
