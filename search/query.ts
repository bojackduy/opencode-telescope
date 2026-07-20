import type { SearchKind } from "./types.ts"

export type ParsedSearchQuery = {
  raw: string
  term: string
  kind?: SearchKind
  tool?: string
  explicitScope: boolean
}

const scopeAliases: Record<string, SearchKind> = {
  user: "user",
  you: "user",
  assistant: "assistant",
  response: "assistant",
  thought: "thought",
  reasoning: "thought",
  patch: "patch",
  diff: "patch",
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const trimmed = raw.trim()
  const base = { raw, term: trimmed, explicitScope: false }
  if (!trimmed) return base

  const inMatch = /^in:([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (inMatch) {
    const kind = scopeAliases[inMatch[1]!.toLowerCase()]
    if (kind) return { raw, term: (inMatch[2] ?? "").trim(), kind, explicitScope: true }
  }

  const toolMatch = /^tool:([a-z0-9_.-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (toolMatch) {
    return { raw, term: (toolMatch[2] ?? "").trim(), tool: toolMatch[1]!.toLowerCase(), explicitScope: true }
  }

  const prefixMatch = /^([a-z][\w-]*):([\s\S]*)$/i.exec(trimmed)
  if (prefixMatch) {
    const kind = scopeAliases[prefixMatch[1]!.toLowerCase()]
    if (kind) return { raw, term: prefixMatch[2]!.trim(), kind, explicitScope: true }
  }

  return base
}

export function searchQueryLabel(raw: string) {
  const parsed = parseSearchQuery(raw)
  if (!parsed.term) return ""
  if (parsed.tool) return `match in tool:${parsed.tool}: ${parsed.term}`
  if (parsed.kind) return `match in ${parsed.kind}: ${parsed.term}`
  return `match: ${parsed.term}`
}
