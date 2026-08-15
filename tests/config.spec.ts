import { describe, expect, it } from 'vitest'
import { DEFAULTS, ENGINE_VALUES, isVoiceEngine } from '../src/core/config'

describe('config 单一事实来源', () => {
  it('ENGINE_VALUES:三个引擎值,顺序即 schema 顺序', () => {
    expect(ENGINE_VALUES).toEqual(['auto', 'browser', 'native'])
  })

  it('isVoiceEngine:合法值真,非法值假', () => {
    expect(isVoiceEngine('auto')).toBe(true)
    expect(isVoiceEngine('browser')).toBe(true)
    expect(isVoiceEngine('native')).toBe(true)
    expect(isVoiceEngine('weird')).toBe(false)
    expect(isVoiceEngine(undefined)).toBe(false)
    expect(isVoiceEngine(42)).toBe(false)
  })

  it('DEFAULTS:与对外文档一致', () => {
    expect(DEFAULTS).toEqual({
      engine: 'auto',
      hotkey: 'ctrl+space',
      modelDir: '',
      vadThreshold: 0.3,
      tailPadSeconds: 0.6,
      asrDir: 'asr-zh',
    })
  })
})
