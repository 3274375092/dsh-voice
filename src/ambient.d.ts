/**
 * 环境桩:out-of-tree 插件独立 typecheck 用的最小结构类型。
 * 每个声明都标注官方源码出处;仓库内集成构建(tsdown + project references)
 * 会以真实类型替代本文件 —— 桩只保证插件自身逻辑的类型正确性。
 * 只保留插件实际引用的形状;未引用的桩(dsh-session 事件、apiproxy 等)已删。
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
    effect(disposer: () => unknown, label?: string): () => void
    [key: string]: unknown
  }
}

// ── @deepseek-ai/schemastery(vendor/schemastery) ─────────────────────
declare module '@deepseek-ai/schemastery' {
  /** 仿 vendor/schemastery:默认导出为 Schema 类(实例方法 + 静态工厂)。 */
  export class Schema<T = unknown> {
    constructor(options?: Partial<Schema<T>>)
    default(value: T): Schema<T>
    min(n: number): Schema<number>
    static object(shape: Record<string, unknown>): Schema<any>
    static string(): Schema<string>
    static const<T extends string>(value: T): Schema<T>
    static union(...schemas: unknown[]): Schema<any>
    static number(): Schema<number>
  }
  export default Schema
}

// ── @deepseek-ai/dsh-client-connection(packages/client/connection) ───
// 0.1.5 起 host/client 两面拆开:根入口只导出 ConnectionRpcResult(历史短名
// RpcResult 已不再从包根 re-export),host 面 augment Context.connection;
// /client 子路径导出 ClientConnectionRpc 与 ConnectionHandle,但**不** augment
// Context —— 客户端插件因此显式声明自己要用的面(见 client/runtime.ts)。
declare module '@deepseek-ai/dsh-client-connection' {
  export interface ConnectionRpcFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }
  export type ConnectionRpcResult<T> = { ok: true; value: T } | { ok: false; error: ConnectionRpcFailure }
  export type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>
  export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>
    intercept(channel: '/api', matches: (endpoint: string) => boolean, handler: ConnectionRpcHandler): () => Promise<void>
  }
}
declare module '@deepseek-ai/dsh-client-connection/client' {
  /** SessionId 为 branded string;插件只在服务边界兑现品牌。 */
  export type SessionId = string & { readonly __sessionId?: unique symbol }
  export type { ConnectionRpcFailure, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
  export interface ClientConnectionRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** host 半:通道注册面(仅 host 入口 augment 此成员)。 */
    connection: {
      rpc: import('@deepseek-ai/dsh-client-connection').HostConnectionRpc
    }
  }
}

// ── @deepseek-ai/dsh-client-ui-renderer/client(packages/client/ui-renderer) ─
// slots 服务的当前归属方;HostObservable 等共享词汇由它 re-export。
declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  export type { HostObservable, SnapshotSelectorHook, MaybeSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
  export interface UiRendererService {
    mount(container: HTMLElement): () => void
  }
}

// ── @deepseek-ai/dsh-api-session-controller/client(packages/api/session-controller) ─
// 0.1.5 起 ctx.sessions 由本包提供(原 dsh-client-runtime/client 已不存在)。
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  import type { Context } from '@deepseek-ai/cordis'
  /** 会话列表快照:current 为当前选中会话(无选中为 undefined)。 */
  export interface SessionListState {
    readonly current?: string
    [key: string]: unknown
  }
  export interface ISessions {
    scope(sessionId: string): Context | undefined
    readonly list: { getSnapshot(): SessionListState }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: import('@deepseek-ai/dsh-api-session-controller/client').ISessions
    slots: import('@deepseek-ai/dsh-client-ui-slots').SlotRegistry
  }
}

// ── @deepseek-ai/dsh-client-ui-slots(packages/client/ui-slots) ───────
declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ComponentType } from 'react'
  export interface HostObservable<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }
  export type HooksSources = Record<string, HostObservable<unknown>>
  export type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S, eq?: (a: S, b: S) => boolean) => S
  export type MaybeSnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S) => S | null
  export type PropsHooks<HS extends HooksSources> = {
    [N in keyof HS & string as `use${Capitalize<N>}`]:
    SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
  }
  export type InjectFace<I extends object> =
    I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I
  export type PropsRuntime<K extends string> = {
    sessionId: string
    renderSlot?: unknown
  } & { [key: string]: unknown }
  export interface SlotRegistry {
    inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
    register(options: Record<string, unknown>, component: ComponentType<any>): () => void
  }
}

// ── @deepseek-ai/dsh-client-ui-conversation/client ───────────────────
// 0.1.5 起会话服务接口名为 IConversation(原 ConversationService),
// 且 send() 返回 Promise<void>(业务失败 reject)。
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  export interface IConversation {
    send(text: string): Promise<void>
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    conversation: import('@deepseek-ai/dsh-client-ui-conversation/client').IConversation
  }
}

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
