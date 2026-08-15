/**
 * 配置的单一事实来源:引擎取值集合、全插件默认值、运行时值守卫。
 * host schema 默认、native-asr 回退、client 竞态兜底都从这里取 ——
 * 默认值与引擎值集只写一次。
 */
import type { VoiceEngine } from '../types.js'

/** 引擎取值集合(host schema 与 isVoiceEngine 守卫同源)。 */
export const ENGINE_VALUES = ['auto', 'browser', 'native'] as const

/** 全插件默认值(单一来源;两半 + native-asr 共用)。 */
export const DEFAULTS = {
  engine: 'auto',
  hotkey: 'ctrl+space',
  modelDir: '',
  vadThreshold: 0.3,
  tailPadSeconds: 0.6,
  asrDir: 'asr-zh',
} as const

/** 运行时值守卫(RPC 下发的 engine 未经验证;host schema 覆盖不到的兜底)。 */
export function isVoiceEngine(value: unknown): value is VoiceEngine {
  return (ENGINE_VALUES as readonly unknown[]).includes(value)
}
