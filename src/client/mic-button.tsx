/**
 * MicButton —— 输入区左侧的语音输入按钮(平台设计系统风格)。
 * 外观:dsh-client-ui-primitives 的 Button 原子 + 平台/自绘图标;
 * 空闲 = 麦克风描边图标,聆听中 = 红色停止图标。
 * 点按 = 一轮识别(兼作浏览器自动播放策略下麦克风权限的用户手势);
 * 停麦后识别文本经 conversation 服务提交(与打字同路,任何 preset 通用)。
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceRuntime } from './runtime'

/** 自绘麦克风描边图标(平台图标库无 mic;风格对齐 icons/index.tsx:16×16 描边 1.5)。 */
export function IconMicrophoneOutline16(): ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="2.75" width="4" height="6.75" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.75 7.25a4.25 4.25 0 0 0 8.5 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 11.75v1.5M5.25 13.25h5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** slot inject 面:apply 里按会话注入。 */
export interface VoiceMicInject {
  runtime: VoiceRuntime
  sessionId: string
  /** 快捷键标签(按钮提示用) */
  hotkey: string
}

export type MicButtonProps =
  PropsRuntime<'conversation.input.left'> &
  InjectFace<VoiceMicInject>

export function MicButton(props: MicButtonProps): ReactElement {
  const { runtime, sessionId, hotkey } = props
  const listening = useSyncExternalStore(
    (cb) => runtime.subscribe(cb),
    () => runtime.isListening(),
  )
  const partial = useSyncExternalStore(
    (cb) => runtime.subscribe(cb),
    () => runtime.getPartial(),
  )

  return (
    <Button
      variant="toolbar"
      size="sm"
      icon={listening
        ? <IconStopFill16 style={{ color: 'var(--dsw-alias-danger, #d33)' }} />
        : <IconMicrophoneOutline16 />}
      aria-label={listening ? '停止语音输入' : '开始语音输入'}
      title={listening
        ? (partial !== '' ? '正在听:' + partial + '(点击停止并提交)' : '正在听…点击停止并提交')
        : '语音输入(' + hotkey + ')'}
      style={listening ? { color: 'var(--dsw-alias-danger, #d33)' } : undefined}
      onClick={() => {
        void runtime.toggleMic(sessionId).catch((err: unknown) => {
          console.error('dsh-voice mic:', err)
        })
      }}
    />
  )
}
