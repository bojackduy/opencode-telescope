import type { IndexSourceRow, Row, SearchKind, SearchResult } from "./types.ts"

export function rowToSearchResult(row: Row, query: string): SearchResult | undefined {
  const text = row.text.trim()
  const match = findMatch(text, query)
  if (!match) return
  const preview = focusedPreview(text, match.start, match.end)
  return {
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    sessionTitle: row.session_title || "Untitled session",
    directory: row.directory,
    role: row.role,
    kind: row.kind,
    partType: row.part_type ?? "text",
    tool: row.tool ?? undefined,
    timeCreated: row.time_created,
    snippet: makeSnippet(text, query),
    matchStart: match.start,
    matchEnd: match.end,
    before: match.before,
    match: match.match,
    after: match.after,
    excerpt: match.excerpt,
    previewBefore: preview.before,
    previewMatch: preview.match,
    previewAfter: preview.after,
    previewMode: preview.mode,
    previewHighlight: preview.highlight,
    text,
    isVectorMatch: false,
    semanticScore: 0,
  }
}

export function rowToVectorResult(row: Row, vectorScore = 0): SearchResult | undefined {
  const text = row.text.trim()
  if (!text) return
  const excerpt = text.slice(0, 200)
  return {
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    sessionTitle: row.session_title || "Untitled session",
    directory: row.directory,
    role: row.role,
    kind: row.kind,
    partType: row.part_type ?? "text",
    tool: row.tool ?? undefined,
    timeCreated: row.time_created,
    snippet: excerpt,
    matchStart: -1,
    matchEnd: -1,
    before: "",
    match: "",
    after: excerpt,
    excerpt,
    previewBefore: text.slice(0, Math.min(text.length, 1400)),
    previewMatch: "",
    previewAfter: "",
    previewMode: "markdown" as const,
    previewHighlight: false,
    text,
    isVectorMatch: true,
    semanticScore: vectorScore,
  }
}

export function makeSnippet(text: string, query: string, radius = 72) {
  const haystack = text.replace(/\s+/g, " ").trim()
  const tokens = query.trim().split(/\s+/)
  const lower = haystack.toLowerCase()
  let searchPos = 0
  let firstIndex = -1
  let lastEnd = 0
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase(), searchPos)
    if (index === -1) return truncate(haystack, radius * 2)
    if (firstIndex === -1) firstIndex = index
    searchPos = index + token.length
    lastEnd = searchPos
  }
  const start = Math.max(0, firstIndex - radius)
  const end = Math.min(haystack.length, lastEnd + radius)
  return `${start > 0 ? "..." : ""}${haystack.slice(start, end)}${end < haystack.length ? "..." : ""}`
}

export function extractSearchText(data: string) {
  try {
    return extractFromValue(JSON.parse(data)).replace(/\s+/g, " ").trim()
  } catch {
    return data.replace(/\s+/g, " ").trim()
  }
}

export function extractIndexText(data: string) {
  try {
    const value = JSON.parse(data) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return ""
    const record = value as Record<string, unknown>
    if (record.type === "text" || record.type === "reasoning") return typeof record.text === "string" ? record.text.trim() : ""
    if (record.type !== "tool") return ""
    return extractToolIndexText(record).replace(/\s+/g, " ").trim()
  } catch {
    return ""
  }
}

export function indexSourceRowToRows(row: IndexSourceRow): Row[] {
  const text = extractIndexText(row.data)
  if (!text) return []
  return [{ ...row, kind: searchKindForRow(row), text }]
}

function searchKindForRow(row: IndexSourceRow): SearchKind {
  if (row.part_type === "tool") return "patch"
  if (row.part_type === "reasoning") return "thought"
  return row.role === "user" ? "user" : "assistant"
}

export function ftsQuery(query: string) {
  const tokens = query.trim().split(/\s+/)
    .map((token) => token.replace(/["*^:()]/g, " ").trim())
    .filter(Boolean)
  if (!tokens.length) return ""
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ")
}

function findMatch(text: string, query: string, radius = 96) {
  const needle = query.trim()
  if (!needle) {
    const collapsed = text.replace(/\s+/g, " ").trim()
    const end = Math.min(collapsed.length, radius * 2)
    return {
      start: 0,
      end: 0,
      before: "",
      match: "",
      after: collapsed.slice(0, end),
      excerpt: collapsed.slice(0, end),
    }
  }
  const tokens = needle.split(/\s+/)
  const lowerText = text.toLowerCase()
  let searchPos = 0
  let firstStart = -1
  let lastEnd = -1
  for (const token of tokens) {
    const pos = lowerText.indexOf(token.toLowerCase(), searchPos)
    if (pos === -1) return
    if (firstStart === -1) firstStart = pos
    searchPos = pos + token.length
    lastEnd = searchPos
  }
  const start = firstStart
  const end = lastEnd
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  const nextLine = text.indexOf("\n", end)
  const lineEnd = nextLine === -1 ? text.length : nextLine
  const line = text.slice(lineStart, lineEnd)
  const matchLen = end - start
  const lineMatchStart = Math.max(0, start - lineStart)
  const lineMatchEnd = lineMatchStart + matchLen
  const excerptStart = Math.max(0, lineMatchStart - radius)
  const excerptEnd = Math.min(line.length, lineMatchEnd + radius)
  const before = normalizeSnippetSegment(line.slice(excerptStart, lineMatchStart))
  const after = normalizeSnippetSegment(line.slice(lineMatchEnd, excerptEnd))
  return {
    start,
    end,
    before: `${excerptStart > 0 ? "..." : ""}${before}`,
    match: text.slice(start, end),
    after: `${after}${excerptEnd < line.length ? "..." : ""}`,
    excerpt: `${excerptStart > 0 ? "..." : ""}${normalizeSnippetSegment(line.slice(excerptStart, excerptEnd))}${excerptEnd < line.length ? "..." : ""}`,
  }
}

function focusedPreview(text: string, matchStart: number, matchEnd: number) {
  if (matchStart === matchEnd) {
    const preview = text.slice(0, Math.min(text.length, 1400))
    return { before: preview, match: "", after: "", mode: "markdown" as const, highlight: false }
  }

  const lineStart = text.lastIndexOf("\n", matchStart - 1) + 1
  const nextLine = text.indexOf("\n", matchEnd)
  const lineEnd = nextLine === -1 ? text.length : nextLine
  const line = text.slice(lineStart, lineEnd)

  if (line.length > 260) {
    const beforeStart = Math.max(0, matchStart - 180)
    const afterEnd = Math.min(text.length, matchEnd + 220)
    return {
      before: `${beforeStart > 0 ? "..." : ""}${text.slice(beforeStart, matchStart)}`,
      match: text.slice(matchStart, matchEnd),
      after: `${text.slice(matchEnd, afterEnd)}${afterEnd < text.length ? "..." : ""}`,
      mode: "text" as const,
      highlight: true,
    }
  }

  const window = lineWindow(text, matchStart, matchEnd, 40, 80)
  const windowText = text.slice(window.start, window.end)
  const relativeStart = matchStart - window.start
  const relativeEnd = matchEnd - window.start

  const insideCodeFence = isInsideCodeFence(text, matchStart)
  return {
    before: `${window.start > 0 ? "...\n" : ""}${windowText.slice(0, relativeStart)}`,
    match: windowText.slice(relativeStart, relativeEnd),
    after: `${windowText.slice(relativeEnd)}${window.end < text.length ? "\n..." : ""}`,
    mode: "markdown" as const,
    highlight: !insideCodeFence,
  }
}

function lineWindow(text: string, matchStart: number, matchEnd: number, before: number, after: number) {
  const starts = [0]
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1)
  }
  const matchLine = findLastStartIndex(starts, matchStart)
  const startLine = Math.max(0, matchLine - before)
  const endLine = Math.min(starts.length - 1, matchLine + after)
  const start = starts[startLine] ?? 0
  const end = starts[endLine + 1] ? starts[endLine + 1] - 1 : text.length
  return { start, end: Math.max(end, matchEnd) }
}

function findLastStartIndex(starts: number[], offset: number) {
  for (let index = starts.length - 1; index >= 0; index--) {
    if (starts[index]! <= offset) return index
  }
  return 0
}

function isInsideCodeFence(text: string, offset: number) {
  const before = text.slice(0, offset)
  const fences = before.match(/^```/gm)
  return Boolean(fences && fences.length % 2 === 1)
}

function normalizeSnippetSegment(value: string) {
  return value.replace(/\s+/g, " ")
}

function extractFromValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (!value) return ""
  if (Array.isArray(value)) return value.map(extractFromValue).filter(Boolean).join("\n")
  if (typeof value !== "object") return ""
  return Object.entries(value)
    .filter(([key]) => !["id", "sessionID", "messageID", "time", "timeCreated", "timeUpdated", "tokens", "cost"].includes(key))
    .map(([, item]) => extractFromValue(item))
    .filter(Boolean)
    .join("\n")
}

function extractToolIndexText(part: Record<string, unknown>) {
  const tool = typeof part.tool === "string" ? part.tool : ""
  const state = recordValue(part.state)
  const input = recordValue(state?.input)
  const metadata = recordValue(state?.metadata)

  if (tool === "apply_patch") {
    const files = Array.isArray(metadata?.files) ? metadata.files : []
    const renderedPatches = files.map(applyPatchFileIndexText).filter(Boolean).join("\n")
    const patchText = stringValue(input?.patchText)
    return [renderedPatches, patchText].filter(Boolean).join("\n")
  }

  if (tool === "edit") {
    const filediff = recordValue(metadata?.filediff)
    return [
      stringValue(input?.filePath),
      stringValue(metadata?.diff),
      stringValue(filediff?.patch),
      stringValue(input?.oldString),
      stringValue(input?.newString),
    ].filter(Boolean).join("\n")
  }

  if (tool === "write") {
    return [stringValue(input?.filePath), stringValue(input?.content)].filter(Boolean).join("\n")
  }

  return ""
}

function applyPatchFileIndexText(value: unknown) {
  const file = recordValue(value)
  if (!file) return ""
  return [
    stringValue(file.filePath),
    stringValue(file.relativePath),
    stringValue(file.patch),
  ].filter(Boolean).join("\n")
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return `${value.slice(0, length - 3)}...`
}

const synonymMap: Record<string, string[]> = {
  greeting: ["hello", "hi", "hey", "howdy", "greetings", "good morning", "good afternoon", "good evening"],
  hello: ["hi", "hey", "howdy", "greeting", "greetings"],
  hi: ["hello", "hey", "howdy", "greeting"],
  hey: ["hello", "hi", "howdy", "greeting"],
  thanks: ["thank you", "thx", "ty", "appreciate", "grateful"],
  goodbye: ["bye", "see you", "farewell", "later", "cya"],
  bye: ["goodbye", "see you", "farewell", "later"],
  error: ["bug", "issue", "failed", "failure", "problem", "exception"],
  bug: ["error", "issue", "problem", "defect"],
  fix: ["repair", "patch", "resolve", "correct", "solve", "bugfix"],
  help: ["assist", "support", "guide", "how to", "tutorial"],
  explain: ["describe", "clarify", "elaborate", "what is", "how does"],
  code: ["program", "source", "implementation", "script", "function"],
  test: ["spec", "unit test", "assertion", "verify", "check"],
  refactor: ["restructure", "rewrite", "improve", "reorganize", "clean up"],
  optimize: ["improve", "speed up", "performance", "efficient", "fast"],
  config: ["configuration", "setting", "option", "setup"],
  deploy: ["release", "publish", "ship", "rollout", "launch"],
  security: ["auth", "permission", "access", "vulnerability", "secure"],
  database: ["db", "sql", "query", "schema", "storage", "persist"],
}

export function expandQuery(query: string): string {
  const trimmed = query.trim()
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length > 1) return trimmed
  const word = tokens[0]
  if (!word) return trimmed
  const synonyms = synonymMap[word]
  if (!synonyms) return trimmed
  const seen = new Set([word])
  const expanded = [trimmed]
  for (const syn of synonyms) {
    const key = syn.toLowerCase()
    if (!seen.has(key)) {
      expanded.push(syn)
      seen.add(key)
    }
  }
  return expanded.join(" ")
}
