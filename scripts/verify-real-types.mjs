/**
 * Real-type verification harness.
 *
 * The plugin's normal `tsc --noEmit` runs against src/ambient.d.ts — hand-written
 * structural stubs. That arrangement can never detect DSH API drift: the stubs
 * are edited to match whatever the source happens to do. This config does the
 * opposite. It resolves each consumed specifier to the REAL package installed in
 * the live DSH, with src/ambient.d.ts excluded, so the compiler checks the plugin
 * against the shipping API rather than against its own assumptions.
 *
 * Run: node scripts/verify-real-types.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const work = join(repo, '.tmp', 'real-types')
const dshPackages = process.env.DSH_PACKAGES_DIR

if (!dshPackages || !existsSync(dshPackages)) {
  console.log('[skip] DSH_PACKAGES_DIR not set or missing; real-type check needs a DSH install.')
  console.log('       Point it at: <dsh>/node_modules/@deepseek-ai')
  process.exit(0)
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
cpSync(join(repo, 'src'), join(work, 'src'), { recursive: true })
// The stubs are exactly what must NOT participate in this check.
rmSync(join(work, 'src', 'ambient.d.ts'), { force: true })

/**
 * Resolve a specifier to its real .d.ts. `types` wins when the package ships
 * one; otherwise fall back to the explicit lib/types path these packages use.
 */
const pkg = (name, sub) => {
  const base = join(dshPackages, name)
  const paths = sub
    ? [`${base}/lib/types/${sub}/index.d.ts`, `${base}/lib/types/${sub}.d.ts`]
    : [`${base}/lib/types/index.d.ts`, `${base}/lib/types/index.d.ts`]
  const found = paths.find(p => existsSync(p))
  if (!found) throw new Error(`cannot resolve ${name}${sub ? '/' + sub : ''} under ${dshPackages}`)
  return found
}

const mappings = {
  '@deepseek-ai/cordis': pkg('cordis'),
  '@deepseek-ai/schemastery': pkg('schemastery'),
  '@deepseek-ai/dsh-client-connection': pkg('dsh-client-connection'),
  '@deepseek-ai/dsh-client-connection/client': pkg('dsh-client-connection', 'client'),
  '@deepseek-ai/dsh-client-ui-renderer/client': pkg('dsh-client-ui-renderer', 'client'),
  '@deepseek-ai/dsh-client-ui-conversation/client': pkg('dsh-client-ui-conversation', 'client'),
  '@deepseek-ai/dsh-api-session-controller/client': pkg('dsh-api-session-controller', 'client'),
  // ui-slots and ui-primitives are platform virtual modules bundled into the
  // shell; no .d.ts ships on disk. The harness supplies a faithful shim.
  '@deepseek-ai/dsh-client-ui-slots': join(work, 'shims', 'ui-slots.d.ts'),
  '@deepseek-ai/dsh-client-ui-primitives': join(work, 'shims', 'ui-primitives.d.ts'),
}

mkdirSync(join(work, 'shims'), { recursive: true })

// Web Speech API: not DSH surface, not in lib.dom. Reproduced so the check
// isolates DSH drift from a missing platform declaration.
writeFileSync(join(work, 'shims', 'web-speech.d.ts'), `
interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionAlternative { readonly transcript: string; readonly confidence: number }
interface SpeechRecognitionResultList {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResult
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}
interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
declare class SpeechRecognition extends EventTarget {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
`)

// ui-slots is bundled into the shell as a platform singleton. This shim mirrors
// the public shared vocabulary the plugin consumes.
writeFileSync(join(work, 'shims', 'ui-slots.d.ts'), `
import type { ComponentType, ReactNode } from 'react'

export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}
export type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S, eq?: (a: S, b: S) => boolean) => S
export type HooksSources = Record<string, HostObservable<unknown>>
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as \`use\${Capitalize<N>}\`]: SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
}
export type InjectFace<I extends object> =
  I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I
export type PropsRuntime<K extends string> = {
  sessionId: string
  useSession?: unknown
  renderSlot?: unknown
} & { [key: string]: unknown }
export interface SlotRegistry {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
}
export type { ReactNode }
`)

// The platform primitives module (Button, icons) — virtual, bundled into the shell.
writeFileSync(join(work, 'shims', 'ui-primitives.d.ts'), `
import type { ButtonHTMLAttributes, CSSProperties, ReactElement, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
export declare function Button(props: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement
export declare function IconStopFill16(props: {
  size?: number
  className?: string
  style?: CSSProperties
}): ReactElement
`)

const paths = Object.fromEntries(Object.entries(mappings).map(([k, v]) => [k, [v]]))

writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2024',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    lib: ['es2024', 'dom', 'dom.iterable'],
    jsx: 'react-jsx',
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    skipLibCheck: true,
    esModuleInterop: true,
    verbatimModuleSyntax: false,
    noEmit: true,
    baseUrl: '.',
    paths,
  },
  include: ['src/**/*.ts', 'src/**/*.tsx', 'shims/**/*.d.ts'],
}, null, 2))

console.log('Verifying plugin source against REAL DSH types')
console.log('  packages:', dshPackages)
console.log('  stubs   : src/ambient.d.ts excluded\n')

const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
try {
  const out = execFileSync(process.execPath, [tsc, '-p', join(work, 'tsconfig.json')], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (out.trim()) console.log(out)
  console.log('\nPASS: source compiles against the real DSH API.')
} catch (err) {
  const output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  console.log(output)
  console.error('FAIL: real-type drift detected (see errors above).')
  process.exitCode = 1
}
