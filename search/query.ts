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

  if (trimmed.startsWith("\\")) {
    const literal = trimmed.slice(1).trim()
    if (literal) return { raw, term: literal, explicitScope: false }
  }

  const plainMatch = /^(?:text|literal):([\s\S]*)$/i.exec(trimmed)
  if (plainMatch) return { raw, term: plainMatch[1]!.trim(), explicitScope: false }

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

function scopeHint(kind: SearchKind, syntax: string): string {
  if (kind === "user") return `${syntax} searches only your prompts.`
  if (kind === "assistant") return `${syntax} searches only assistant replies.`
  if (kind === "thought") return `${syntax} searches assistant reasoning/thought parts.`
  return `${syntax} searches code edits, patches, and changed file names.`
}

export function searchQueryHint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return "Bare search: user prompts + assistant replies. Try patch:SearchResponse or thought:indexing"

  const lower = trimmed.toLowerCase()
  if (lower === "text:" || lower === "literal:") return "text:<term> searches plain conversation text, even if the term looks like scope syntax."
  if (lower === "in:") return "in:<scope> <term> supports user, assistant, thought, and patch."
  if (lower === "tool:") return "tool:<name> <term> searches one tool, for example tool:apply_patch SearchResponse."
  if (trimmed.startsWith("\\")) return "Leading \\ searches the rest as plain text, not scope syntax."

  const plainMatch = /^(?:text|literal):([\s\S]*)$/i.exec(trimmed)
  if (plainMatch) return "Plain search treats scope-like text literally."

  const inMatch = /^in:([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (inMatch && !(inMatch[2] ?? "").trim()) {
    const kind = scopeAliases[inMatch[1]!.toLowerCase()]
    if (kind) return scopeHint(kind, `in:${kind} <term>`)
  }

  const toolMatch = /^tool:([a-z0-9_.-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (toolMatch && !(toolMatch[2] ?? "").trim()) {
    const tool = toolMatch[1]!.toLowerCase()
    return `tool:${tool} <term> searches ${tool} content.`
  }

  const prefixMatch = /^([a-z][\w-]*):([\s\S]*)$/i.exec(trimmed)
  if (prefixMatch && !prefixMatch[2]!.trim()) {
    const kind = scopeAliases[prefixMatch[1]!.toLowerCase()]
    if (kind) return scopeHint(kind, `${kind}:<term>`)
  }

  const parsed = parseSearchQuery(raw)
  if (parsed.explicitScope && parsed.term) return "Scoped search overrides the owner toggle."
  return "Bare search excludes thoughts and patches. Use thought: or patch: to include them."
}
