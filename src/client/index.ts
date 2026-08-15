/**
 * dsh-voice client 半(浏览器)。
 * 挂一个麦克风按钮到 conversation.input.left;按钮负责一轮语音识别,
 * 识别文本经 conversation 服务提交(与打字同路)。另注册全局快捷键
 * (默认 Ctrl+Space)开关麦克风;输入框聚焦时不触发,避免与输入法冲突。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import z from '@deepseek-ai/schemastery'
import { VoiceRuntime, type VoiceRuntimeConfig } from './runtime.js'
import { hotkeyLabel, parseHotkey } from './hotkey.js'
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
  const runtime = new VoiceRuntime(ctx, { engine: config.engine })

  // 麦克风按钮(会话槽)
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-mic',
    order: 0,
    inject: (sessionId) => ({ runtime, sessionId, hotkey: hotkeyLabel(config.hotkey) }),
  }, MicButton))

  // 全局快捷键:开关当前会话的麦克风
  const hotkey = parseHotkey(config.hotkey)
  if (hotkey !== null) {
    ctx.effect(() => {
      const onKey = (event: KeyboardEvent) => {
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
  }
}
