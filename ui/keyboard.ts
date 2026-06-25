import type { ParsedKey } from "@opentui/core"

export function isKey(evt: ParsedKey, ...names: string[]) {
  return names.includes(evt.name)
}

export function matchesKey(evt: ParsedKey, keys: string[]) {
  return keys.some((key) => matchesKeyString(evt, key))
}

export function keyListLabel(keys: string[]) {
  return keys.map(keyLabel).join("/")
}

export function inputSafeKeys(keys: string[]) {
  return keys.filter((key) => key.includes("+") || key.length > 1)
}

function matchesKeyString(evt: ParsedKey, key: string) {
  const parts = key.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean)
  const name = parts.at(-1)
  if (!name || evt.name.toLowerCase() !== name) return false

  const modifiers = new Set(parts.slice(0, -1))
  return Boolean(evt.ctrl) === modifiers.has("ctrl") &&
    Boolean(evt.meta) === modifiers.has("meta") &&
    Boolean(evt.shift) === modifiers.has("shift") &&
    Boolean(evt.option) === (modifiers.has("alt") || modifiers.has("option"))
}

function keyLabel(key: string) {
  return key.split("+")
    .map((part) => {
      const value = part.trim()
      if (value.toLowerCase() === "ctrl") return "^"
      return value
    })
    .join("")
}

export function prevent(evt: ParsedKey) {
  const controlled = evt as ParsedKey & {
    preventDefault?: () => void
    stopPropagation?: () => void
  }
  controlled.preventDefault?.()
  controlled.stopPropagation?.()
}
