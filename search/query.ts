import type { SearchKind } from "./types.ts"

export type SearchQueryClause = {
  term: string
  kind?: SearchKind
  tool?: string
}

export type ParsedSearchQuery = {
  raw: string
  term: string
  kind?: SearchKind
  tool?: string
  explicitScope: boolean
  clauses: SearchQueryClause[]
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
  const base = parsedQuery(raw, [{ term: trimmed }])
  if (!trimmed) return base

  if (trimmed.startsWith("\\")) {
    const literal = trimmed.slice(1).trim()
    if (literal) return parsedQuery(raw, [{ term: literal }])
  }

  const plainMatch = /^(?:text|literal):([\s\S]*)$/i.exec(trimmed)
  if (plainMatch) return parsedQuery(raw, [{ term: plainMatch[1]!.trim() }])

  return parsedQuery(raw, parseClauses(tokenizeSearchQuery(trimmed)))
}

export function searchQueryLabel(raw: string) {
  const parsed = parseSearchQuery(raw)
  if (!parsed.term) return ""
  if (parsed.clauses.length > 1) return `match any: ${parsed.clauses.map(clauseLabel).join(" | ")}`
  if (parsed.tool) return `match in tool:${parsed.tool}: ${parsed.term}`
  if (parsed.kind) return `match in ${parsed.kind}: ${parsed.term}`
  return `match: ${parsed.term}`
}

function clauseLabel(clause: SearchQueryClause) {
  if (clause.tool) return `tool:${clause.tool}: ${clause.term}`
  if (clause.kind) return `${clause.kind}: ${clause.term}`
  return clause.term
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
  if (parsed.clauses.length > 1 && parsed.explicitScope) return "Mixed scopes use OR; scoped clauses override the owner toggle."
  if (parsed.clauses.length > 1) return "Multiple clauses use OR."
  if (parsed.explicitScope && parsed.term) return "Scoped search overrides the owner toggle."
  return "Bare search excludes thoughts and patches. Use thought: or patch: to include them."
}

function parsedQuery(raw: string, clauses: SearchQueryClause[]): ParsedSearchQuery {
  const normalized = clauses.length ? clauses : [{ term: "" }]
  const explicitScope = normalized.some((clause) => Boolean(clause.kind || clause.tool))
  const single = normalized.length === 1 ? normalized[0] : undefined
  return {
    raw,
    term: normalized.map((clause) => clause.term).filter(Boolean).join(" ").trim(),
    kind: single?.kind,
    tool: single?.tool,
    explicitScope,
    clauses: normalized,
  }
}

function parseClauses(tokens: string[]): SearchQueryClause[] {
  type DraftClause = Omit<SearchQueryClause, "term"> & { terms: string[] }

  const clauses: SearchQueryClause[] = []
  let current: DraftClause | undefined

  const pushCurrent = () => {
    if (!current) return
    clauses.push({ term: current.terms.join(" ").trim(), kind: current.kind, tool: current.tool })
    current = undefined
  }

  const startClause = (clause: Omit<SearchQueryClause, "term">, term = "") => {
    pushCurrent()
    current = { ...clause, terms: term ? [term] : [] }
  }

  const addBare = (term: string) => {
    if (!term) return
    current ??= { terms: [] }
    current.terms.push(term)
  }

  for (const token of tokens) {
    if (token === "OR") {
      pushCurrent()
      continue
    }

    if (token.startsWith("\\")) {
      addBare(token.slice(1))
      continue
    }

    const inMatch = /^in:([a-z][\w-]*)$/i.exec(token)
    if (inMatch) {
      const kind = scopeAliases[inMatch[1]!.toLowerCase()]
      if (kind) {
        startClause({ kind })
        continue
      }
    }

    const toolMatch = /^tool:([a-z0-9_.-]+)$/i.exec(token)
    if (toolMatch) {
      startClause({ tool: toolMatch[1]!.toLowerCase() })
      continue
    }

    const prefixMatch = /^([a-z][\w-]*):([\s\S]*)$/i.exec(token)
    if (prefixMatch) {
      const prefix = prefixMatch[1]!.toLowerCase()
      const value = prefixMatch[2]!.trim()
      if (prefix === "text" || prefix === "literal") {
        startClause({}, value)
        continue
      }

      const kind = scopeAliases[prefix]
      if (kind) {
        startClause({ kind }, value)
        continue
      }
    }

    addBare(token)
  }

  pushCurrent()
  return clauses.length ? clauses : [{ term: "" }]
}

function tokenizeSearchQuery(input: string) {
  const tokens: string[] = []
  let current = ""
  let quote: string | undefined

  const push = () => {
    if (current) tokens.push(current)
    current = ""
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === "\\" && input[index + 1] === quote) {
        current += input[index + 1]
        index++
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      push()
      continue
    }

    current += char
  }

  push()
  return tokens
}
