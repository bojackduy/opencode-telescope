import type { ParsedKey } from "@opentui/core"

export function isKey(evt: ParsedKey, ...names: string[]) {
  return names.includes(evt.name)
}

export function prevent(evt: ParsedKey) {
  const controlled = evt as ParsedKey & {
    preventDefault?: () => void
    stopPropagation?: () => void
  }
  controlled.preventDefault?.()
  controlled.stopPropagation?.()
}
