import type { ConversationPreviewPart } from "../search.ts"

export type PreviewLayoutRow = {
  part: ConversationPreviewPart
  top: number
  bottom: number
  height: number
}

export function estimatePreviewPartHeight(part: ConversationPreviewPart, width: number) {
  const charsPerLine = Math.max(60, width - 8)
  if (part.type === "tool") {
    if (!part.target) return 2
    if (part.tool === "write") return 40
    if (part.tool === "edit" || part.tool === "apply_patch") return 35
    return 2
  }
  if (part.type === "reasoning") return Math.min(24, Math.max(2, Math.ceil(part.text.length / charsPerLine)))
  return Math.min(90, Math.max(3, Math.ceil(part.text.length / charsPerLine)))
}

export function buildPreviewLayout(parts: ConversationPreviewPart[], heightOf: (part: ConversationPreviewPart) => number): PreviewLayoutRow[] {
  let offset = 0
  return parts.map((part) => {
    const height = heightOf(part)
    const row = { part, top: offset, bottom: offset + height, height }
    offset += height
    return row
  })
}

export function mergePreviewParts(prev: ConversationPreviewPart[], next: ConversationPreviewPart[]) {
  const existing = new Set(prev.map((part) => part.id))
  const fresh = next.filter((part) => !existing.has(part.id))
  if (fresh.length === 0) return prev
  return [...fresh, ...prev]
}

export function previewWindowForLayout(layout: PreviewLayoutRow[], scrollTop: number, viewportHeight: number) {
  if (layout.length === 0) return { start: 0, end: 0 }
  const overscan = Math.max(viewportHeight * 2, 40)
  const from = Math.max(0, scrollTop - overscan)
  const to = scrollTop + viewportHeight + overscan
  const foundStart = layout.findIndex((row) => row.bottom >= from)
  const start = foundStart === -1 ? Math.max(0, layout.length - 1) : Math.max(0, foundStart)
  const foundEnd = layout.findIndex((row) => row.top > to)
  const end = foundEnd === -1 ? layout.length : foundEnd
  return { start, end: Math.min(layout.length, Math.max(start + 1, end)) }
}

export function ensurePreviewWindowIncludesTarget(window: { start: number; end: number }, layout: PreviewLayoutRow[], targetPartID: string | undefined) {
  if (!targetPartID) return window
  const targetIndex = layout.findIndex((row) => row.part.id === targetPartID)
  if (targetIndex === -1 || (targetIndex >= window.start && targetIndex < window.end)) return window
  const start = Math.min(window.start, targetIndex)
  const end = Math.max(window.end, targetIndex + 1)
  return { start, end }
}
