/** 快捷键解析(纯函数,独立模块便于单测)。 */

export interface ParsedHotkey {
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** KeyboardEvent.code */
  code: string
}

/** 修饰键别名 → 规范名(parse 与 label 共享,消除双重编码)。 */
const MODIFIER_KEYS: Record<string, 'ctrl' | 'alt' | 'shift'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  shift: 'shift',
}

const MODIFIER_LABELS: Record<'ctrl' | 'alt' | 'shift', string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
}

/** 拆分 "ctrl+space" → 小写部件(两处共用)。 */
function splitParts(spec: string): string[] {
  return spec.toLowerCase().split('+').map(p => p.trim()).filter(p => p !== '')
}

/** 解析 "ctrl+space" 形式;无法解析返回 null(快捷键禁用)。 */
export function parseHotkey(spec: string): ParsedHotkey | null {
  const parsed: ParsedHotkey = { ctrl: false, alt: false, shift: false, code: '' }
  let key = ''
  for (const p of splitParts(spec)) {
    const mod = MODIFIER_KEYS[p]
    if (mod !== undefined) parsed[mod] = true
    else key = p
  }
  if (key === '') return null
  parsed.code = key === 'space' ? 'Space'
    : key === 'enter' ? 'Enter'
    : key === 'esc' ? 'Escape'
    : /^[a-z0-9]$/.test(key) ? 'Key' + key.toUpperCase()
    : key
  return parsed
}

/** 快捷键的人类可读标签(按钮提示用)。 */
export function hotkeyLabel(spec: string): string {
  const parts = splitParts(spec)
  const key = parts.filter(p => MODIFIER_KEYS[p] === undefined).pop() ?? ''
  const prefix = parts.filter(p => MODIFIER_KEYS[p] !== undefined)
    .map(p => MODIFIER_LABELS[MODIFIER_KEYS[p]!])
    .join('+')
  const keyLabel = key === 'space' ? '空格' : key === '' ? '' : key.toUpperCase()
  return prefix === '' ? keyLabel : prefix + '+' + keyLabel
}
