/** 快捷键解析(纯函数,独立模块便于单测)。 */

export interface ParsedHotkey {
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** KeyboardEvent.code */
  code: string
}

/** 解析 "ctrl+space" 形式;无法解析返回 null(快捷键禁用)。 */
export function parseHotkey(spec: string): ParsedHotkey | null {
  const parts = spec.toLowerCase().split('+').map(p => p.trim()).filter(p => p !== '')
  let ctrl = false
  let alt = false
  let shift = false
  let key = ''
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') ctrl = true
    else if (p === 'alt') alt = true
    else if (p === 'shift') shift = true
    else key = p
  }
  if (key === '') return null
  const code = key === 'space' ? 'Space'
    : key === 'enter' ? 'Enter'
    : key === 'esc' ? 'Escape'
    : /^[a-z0-9]$/.test(key) ? 'Key' + key.toUpperCase()
    : key
  return { ctrl, alt, shift, code }
}

/** 快捷键的人类可读标签(按钮提示用)。 */
export function hotkeyLabel(spec: string): string {
  const parts = spec.toLowerCase().split('+').map(p => p.trim()).filter(p => p !== '')
  const mods: Record<string, string> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift' }
  const key = parts.filter(p => mods[p] === undefined).pop() ?? ''
  const prefix = parts.filter(p => mods[p] !== undefined).map(p => mods[p] ?? p).join('+')
  const keyLabel = key === 'space' ? '空格' : key === '' ? '' : key.toUpperCase()
  return prefix === '' ? keyLabel : prefix + '+' + keyLabel
}
