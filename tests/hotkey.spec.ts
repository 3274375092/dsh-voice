import { describe, expect, it } from 'vitest'
import { hotkeyLabel, parseHotkey } from '../src/client/hotkey'

describe('parseHotkey(快捷键解析)', () => {
  it('ctrl+space', () => {
    expect(parseHotkey('ctrl+space')).toEqual({ ctrl: true, alt: false, shift: false, code: 'Space' })
  })
  it('alt+m / 大小写与空白容错', () => {
    expect(parseHotkey('Alt+M')).toEqual({ ctrl: false, alt: true, shift: false, code: 'KeyM' })
    expect(parseHotkey(' ctrl + shift + p ')).toEqual({ ctrl: true, alt: false, shift: true, code: 'KeyP' })
  })
  it('无修饰键裸键', () => {
    expect(parseHotkey('m')).toEqual({ ctrl: false, alt: false, shift: false, code: 'KeyM' })
  })
  it('非法规格返回 null(禁用)', () => {
    expect(parseHotkey('')).toBeNull()
    expect(parseHotkey('ctrl+')).toBeNull()
  })
})

describe('hotkeyLabel(人类可读标签)', () => {
  it('ctrl+space → Ctrl+空格', () => {
    expect(hotkeyLabel('ctrl+space')).toBe('Ctrl+空格')
  })
  it('alt+m → Alt+M', () => {
    expect(hotkeyLabel('alt+m')).toBe('Alt+M')
  })
})
