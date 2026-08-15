/**
 * dsh-voice client 半(浏览器)。
 * 挂一个麦克风按钮到 conversation.input.left;按钮负责一轮语音识别,
 * 识别文本经 conversation 服务提交(与打字同路)。另注册全局快捷键
 * (默认 Ctrl+Space)开关麦克风;输入框聚焦时不触发,避免与输入法冲突。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import z from '@deepseek-ai/schemastery'
import { VoiceRuntime, type VoiceRuntimeConfig } from './runtime.js'
import { hotkeyLabel, parseHotkey, type ParsedHotkey } from './hotkey.js'
import { Emitter } from '../core/emitter.js'
import type { VoiceClientConfig, VoiceEngine } from '../types.js'
import { MicButton } from './mic-button.js'

export const name = 'dsh-voice'
export const inject = ['sessions', 'slots', 'connection']

export interface Config {
  engine: 'auto' | 'browser' | 'native'
  /** 全局开关麦克风的快捷键,格式 "ctrl+space" / "alt+m" 等 */
  hotkey: string
}

export const Config: z<Config> = z.object({
  engine: z.union([z.const('auto'), z.const('browser'), z.const('native')]).default('auto'),
  hotkey: z.string().default('ctrl+space'),
})


export function apply(ctx: ClientContext, config: Config): void {
  // web shell 用 loader.create({ name }) 创建 client 条目,行内 config 不会
  // 传给 client apply。这里先用 client 自己的 schema 默认值兜底,再由 host
  // 半经 /voice.config 把真正生效的行内配置同步回来。
  const clientConfig: VoiceClientConfig = { engine: config.engine, hotkey: config.hotkey }
  const configEvents = new Emitter<[]>()
  const runtime = new VoiceRuntime(ctx, { engine: clientConfig.engine })

  // 业务状态经标准 hooks compartment 进组件:组件只拿到 useListening/usePartial
  // 与纯回调,不接触整个 runtime 对象,也不自行 useSyncExternalStore。
  const listeningSource: HostObservable<boolean> = {
    getSnapshot: () => runtime.isListening(),
    subscribe: (cb) => runtime.subscribe(cb),
  }
  const partialSource: HostObservable<string> = {
    getSnapshot: () => runtime.getPartial(),
    subscribe: (cb) => runtime.subscribe(cb),
  }
  const hotkeySource: HostObservable<string> = {
    getSnapshot: () => hotkeyLabel(clientConfig.hotkey),
    subscribe: (cb) => configEvents.on(cb),
  }

  // 麦克风按钮(会话槽)
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-mic',
    order: 0,
    inject: (sessionId) => ({
      onToggle: () => {
        void runtime.toggleMic(sessionId).catch((err: unknown) => {
          console.error('dsh-voice mic:', err)
        })
      },
      hooks: { listening: listeningSource, partial: partialSource, hotkey: hotkeySource },
    }),
  }, MicButton))

  // 全局快捷键:开关当前会话的麦克风。hotkey 变量在 /voice.config 返回后
  // 原地更新,keydown 监听器每次读取最新值,无需重建 effect。
  let hotkey: ParsedHotkey | null = parseHotkey(clientConfig.hotkey)
  ctx.effect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hotkey === null) return
      if (event.ctrlKey !== hotkey.ctrl || event.altKey !== hotkey.alt || event.shiftKey !== hotkey.shift) return
      if (event.code !== hotkey.code) return
      // 输入框/编辑器聚焦时不抢快捷键(避免与输入法/编辑操作冲突)
      const target = event.target as HTMLElement | null
      if (target !== null && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      )) return
      event.preventDefault()
      const current = ctx.sessions.list.getSnapshot().current
      if (current === undefined) return
      void runtime.toggleMic(current).catch((err: unknown) => {
        console.error('dsh-voice mic:', err)
      })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, 'dsh-voice: global hotkey')

  const isVoiceEngine = (value: unknown): value is VoiceEngine =>
    value === 'auto' || value === 'browser' || value === 'native'

  // 行内 config 只到 host 半;client 半从这里取回真实值并覆盖 schema 默认。
  void ctx.connection.rpc.call('/voice', 'config', {}).then((res) => {
    if (!res.ok) return
    const remote = res.value as Partial<VoiceClientConfig> | undefined
    if (remote === undefined) return
    if (isVoiceEngine(remote.engine)) {
      clientConfig.engine = remote.engine
      runtime.setEngine(remote.engine)
    }
    if (typeof remote.hotkey === 'string' && remote.hotkey.trim() !== '' && remote.hotkey !== clientConfig.hotkey) {
      clientConfig.hotkey = remote.hotkey
      hotkey = parseHotkey(remote.hotkey)
      configEvents.emit()
    }
  }).catch((err: unknown) => {
    console.warn('dsh-voice: /voice.config 不可用,使用 client 默认配置', err)
  })
}
