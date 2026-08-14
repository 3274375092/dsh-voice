/**
 * 环境桩:out-of-tree 插件独立 typecheck 用的最小结构类型。
 * 每个声明都标注官方源码出处;仓库内集成构建(tsdown + project references)
 * 会以真实类型替代本文件 —— 桩只保证插件自身逻辑的类型正确性。
 */

// ── @deepseek-ai/cordis(vendor/cordis) ───────────────────────────────
declare module '@deepseek-ai/cordis' {
  export interface Logger {
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    info(...args: unknown[]): void
  }
  export interface Context {
    readonly logger: Logger
    get<T = unknown>(name: string): T | undefined
    on<K extends string>(event: K, cb: (...args: any[]) => void): () => void
    effect(disposer: () => unknown, label?: string): () => void
    provide(name: string, value: unknown): void
    plugin(plugin: unknown): void
    inject(names: string[], cb: (scope: Context) => void): void
    [key: string]: unknown
  }
}

// ── @deepseek-ai/schemastery(vendor/schemastery) ─────────────────────
declare module '@deepseek-ai/schemastery' {
  /** 仿 vendor/schemastery:默认导出为 Schema 类(实例方法 + 静态工厂)。 */
  export class Schema<T = unknown> {
    constructor(options?: Partial<Schema<T>>)
    default(value: T): Schema<T>
    required(): Schema<T>
    min(n: number): Schema<number>
    static object(shape: Record<string, unknown>): Schema<any>
    static string(): Schema<string>
    static boolean(): Schema<boolean>
    static const<T extends string>(value: T): Schema<T>
    static union(...schemas: unknown[]): Schema<any>
    static array(item: unknown): Schema<unknown[]>
    static number(): Schema<number>
    static natural(): Schema<number>
  }
  export default Schema
}

// ── @deepseek-ai/dsh-session(packages/core/session) ──────────────────
// SessionEventMap 节选(types.ts:243-299);chunk 形状见 dsh-llm/types.ts:291-303
declare module '@deepseek-ai/dsh-session' {
  export type TextDeltaChunk = { type: 'text-delta'; index: number; text: string }
  export type StreamChunk =
    | TextDeltaChunk
    | { type: 'block-start'; index: number; blockType: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: unknown; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: unknown }
    | { type: 'usage'; usage: unknown }
    | { type: 'finish'; reason: unknown; replayState?: unknown }

  export interface Session {
    readonly id: string
  }

  export type SessionEventMap = {
    'turn/start': { turn: number }
    'turn/end': { turn: number; reason: { kind: string } }
    'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
    'assistant/message': { turn: number; step: number; message: unknown }
    'tool/call': { turn: number; step: number; callId: unknown; name: string; arguments: string }
    'user/message': unknown
  }

  export type SessionEvent = {
    [K in keyof SessionEventMap]: { type: K; seq: number; time: number; data: SessionEventMap[K] }
  }[keyof SessionEventMap]
}

// session/event 事件(host 侧 ctx.on;core/session/src/index.ts:76)
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: import('@deepseek-ai/dsh-session').Session, event: import('@deepseek-ai/dsh-session').SessionEvent): void
  }
}

// ── @deepseek-ai/dsh-client-connection(packages/client/connection) ───
declare module '@deepseek-ai/dsh-client-connection' {
  export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: unknown } }
  export type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>
  export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler, options: { authority: 'loopback' | 'trusted-host' }): () => Promise<void>
  }
  export interface HostConnectionHandle {
    readonly rpc: HostConnectionRpc
  }
  export interface ClientConnectionRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: {
      rpc: import('@deepseek-ai/dsh-client-connection').HostConnectionRpc
    }
  }
}

// ── @deepseek-ai/dsh-client-runtime/client(packages/client/runtime) ──
declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export type ClientContext = Context & {
    slots: import('@deepseek-ai/dsh-client-ui-slots').SlotRegistry
    sessions: ClientSessions
    connection: {
      rpc: import('@deepseek-ai/dsh-client-connection').ClientConnectionRpc
    }
  }
  export interface ClientSessions {
    scope(sessionId: string): Context | undefined
    list: { getSnapshot(): { current?: string } }
  }
  export type AssistantBlock =
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'tool'; [key: string]: unknown }
  export interface PartialAssistant {
    readonly turn: number
    readonly step: number
    readonly blocks: readonly AssistantBlock[]
  }
  export interface ConversationSnapshot {
    /** assistant/message 定稿后 partial 被取代为 null(partial.ts:86) */
    readonly partial: PartialAssistant | null
    [key: string]: unknown
  }
  export type SnapshotSelectorHook<S> = <T>(selector: (snapshot: S) => T) => T
  export type MaybeSnapshotSelectorHook<S> = <T>(selector: (snapshot: S) => T) => T | null
}

// ── @deepseek-ai/dsh-client-ui-slots(packages/client/ui-slots) ───────
declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ComponentType } from 'react'
  export type PropsRuntime<K extends string> = {
    useSession: import('@deepseek-ai/dsh-client-runtime/client').SnapshotSelectorHook<import('@deepseek-ai/dsh-client-runtime/client').ConversationSnapshot>
    sessionId: string
    useProjection?: unknown
    zone?: unknown
  }
  export type InjectFace<I> = I
  export interface SlotRegisterOptions {
    name: string
    id: string
    order?: number
    inject?: (sessionId: string) => object
  }
  export interface SlotRegistry {
    inject(name: string, factory: () => () => void): void
    register(options: SlotRegisterOptions, component: ComponentType<any>): () => void
  }
}

// ── @deepseek-ai/dsh-client-ui-conversation/client ───────────────────
// 会话 scope 内的 conversation 服务(service.ts:129-133)
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  export interface ConversationService {
    send(text: string): void
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    conversation: import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationService
  }
}

// ── @deepseek-ai/dsh-host-apiproxy/api(RpcResult,host 用) ────────────
declare module '@deepseek-ai/dsh-host-apiproxy/api' {
  export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: unknown } }
}

// ── @deepseek-ai/dsh-session 的 SessionEvent 只读冻结等细节桩不覆盖 ──

// ── Web Speech API(TS lib.dom 缺失;结构来自 MDN) ──────────────────
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
interface Window {
  SpeechRecognition?: new () => SpeechRecognition
  webkitSpeechRecognition?: new () => SpeechRecognition
}

// ── @deepseek-ai/dsh-host-apiproxy(裸入口,仅类型合并占位) ──────────
declare module '@deepseek-ai/dsh-host-apiproxy' {}

// ── @deepseek-ai/dsh-client-ui-primitives(packages/client/ui-primitives) ─
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, CSSProperties, ReactElement, ReactNode } from 'react'
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement
  export function IconStopFill16(props: { size?: number; className?: string; style?: CSSProperties }): ReactElement
}
