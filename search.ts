import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { debug } from "./ui/debug.ts"

export type SearchResult = {
  id: string
  messageID: string
  sessionID: string
  sessionTitle: string
  directory: string
  role: "user" | "assistant"
  timeCreated: number
  snippet: string
  matchStart: number
  matchEnd: number
  before: string
  match: string
  after: string
  excerpt: string
  previewBefore: string
  previewMatch: string
  previewAfter: string
  previewMode: "markdown" | "text"
  previewHighlight: boolean
  text: string
}

export type SearchRole = "user" | "assistant"

export type ConversationPreviewPart = {
  id: string
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  type: "text" | "reasoning" | "tool"
  timeCreated: number
  text: string
  tool?: string
  state?: ToolState
  target: boolean
}

export type ConversationPreviewPage = {
  parts: ConversationPreviewPart[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export type ConversationPreviewCursor = {
  id: string
  timeCreated: number
}

export type ToolState = {
  status: "pending" | "running" | "completed" | "error"
  input?: unknown
  output?: string
  error?: string
}

type Row = {
  id: string
  message_id: string
  session_id: string
  session_title: string | null
  directory: string
  role: SearchRole
  time_created: number
  text: string
}

type ConversationRow = {
  id: string
  message_id: string
  session_id: string
  role: SearchRole
  type: "text" | "reasoning" | "tool"
  time_created: number
  data: string
}

let cachedDbPath: string | undefined
let _db: Database | undefined
let _dbPath: string | undefined
let _indexDb: Database | undefined
let _indexDbPath: string | undefined

function getDb(dbPath?: string): Database {
  const resolved = dbPath ?? resolveDatabasePath()
  if (!_db || resolved !== _dbPath) {
    _db?.close()
    _db = new Database(resolved, { readonly: true })
    _dbPath = resolved
    tableCache.clear()
  }
  return _db
}

export function resolveDatabasePath() {
  if (cachedDbPath) return cachedDbPath
  if (process.env.OPENCODE_DB) {
    if (process.env.OPENCODE_DB === ":memory:" || path.isAbsolute(process.env.OPENCODE_DB)) return cachedDbPath = process.env.OPENCODE_DB
    return cachedDbPath = path.join(candidateDataDirs()[0] ?? defaultDataDir(), process.env.OPENCODE_DB)
  }
  if (process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
    return cachedDbPath = requireExistingDatabase(["opencode.db"])
  }
  const stable = candidateDatabasePaths(["opencode.db"]).find(existsSync)
  if (stable) return cachedDbPath = stable
  if (process.env.OPENCODE_CHANNEL) {
    const channel = process.env.OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
    const candidate = candidateDatabasePaths([`opencode-${channel}.db`]).find(existsSync)
    if (candidate) return cachedDbPath = candidate
  }
  const fallback = candidateDatabasePaths(["opencode.db"])[0] ?? path.join(defaultDataDir(), "opencode.db")
  try {
    const discovered = candidateDataDirs()
      .flatMap((dir) =>
        readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^opencode-.+\.db$/.test(entry.name))
          .map((entry) => path.join(dir, entry.name)),
      )
      .at(0)
    return cachedDbPath = discovered ?? fallback
  } catch {
    return cachedDbPath = fallback
  }
}

export function searchSessionMessages(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  const term = query.trim()
  if (!term) return []
  if (options?.dbPath === ":memory:") return []
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  return searchRows(db, dbPath, term, options?.limit ?? 80, options?.directory, options?.offset, options?.role)
}

export function recentSessionMessages(options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  const db = getDb(options?.dbPath)
  return visibleTextRows(db, options?.limit ?? 40, undefined, options?.directory, options?.offset, options?.role).flatMap(
    (row) => rowToSearchResult(row, "") ?? [],
  )
}

export function loadConversationAround(result: SearchResult, options?: { before?: number; after?: number; dbPath?: string }): ConversationPreviewPage {
  debug.time("preview:query:total")
  const db = getDb(options?.dbPath)
  const before = options?.before ?? 3
  const after = options?.after ?? 6

  debug.time("preview:query:hit")
  const hit = db.query<{ time_created: number }, [string]>(
    "SELECT time_created FROM part WHERE id = ?",
  ).get(result.id)
  debug.timeEnd("preview:query:hit")
  if (!hit) {
    debug.log("preview:window", {
      item: result.id,
      session: result.sessionID,
      before,
      after,
      hit: false,
    })
    debug.timeEnd("preview:query:total")
    return { parts: [], hasMoreBefore: false, hasMoreAfter: false }
  }

  const fetchBefore = Math.max(before * 4, before + 1, 30)
  const fetchAfter = Math.max((after + 1) * 4, after + 2, 50)

  debug.time("preview:query:before")
  const beforeRows = db.query<ConversationRow, [string, number, number, string, number]>(`
    SELECT p.id, p.message_id, p.session_id,
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.type') AS type,
           p.time_created, p.data
    FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ?
      AND (p.time_created < ? OR (p.time_created = ? AND p.id < ?))
    ORDER BY p.time_created DESC, p.id DESC
    LIMIT ?
  `).all(result.sessionID, hit.time_created, hit.time_created, result.id, fetchBefore)
  debug.timeEnd("preview:query:before")

  debug.time("preview:query:after")
  const afterRows = db.query<ConversationRow, [string, number, number, string, number]>(`
    SELECT p.id, p.message_id, p.session_id,
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.type') AS type,
           p.time_created, p.data
    FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ?
      AND (p.time_created > ? OR (p.time_created = ? AND p.id >= ?))
    ORDER BY p.time_created ASC, p.id ASC
    LIMIT ?
  `).all(result.sessionID, hit.time_created, hit.time_created, result.id, fetchAfter)
  debug.timeEnd("preview:query:after")

  debug.time("preview:query:parse")
  const validBefore = beforeRows.filter(isPreviewRow)
  const validAfter = afterRows.filter(isPreviewRow)
  const parts = [
    ...validBefore.slice(0, before).reverse(),
    ...validAfter.slice(0, after + 1),
  ].flatMap((row) => parseConversationPart(row, row.id === result.id) ?? [])
  const page = {
    parts,
    hasMoreBefore: validBefore.length > before,
    hasMoreAfter: validAfter.length > after + 1,
  }
  debug.log("preview:window", {
    item: result.id,
    session: result.sessionID,
    mode: "around",
    before,
    after,
    fetchBefore,
    fetchAfter,
    beforeRows: beforeRows.length,
    afterRows: afterRows.length,
    parts: parts.length,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    first: parts[0]?.id,
    last: parts.at(-1)?.id,
  })
  debug.timeEnd("preview:query:parse")
  debug.timeEnd("preview:query:total")
  return page
}

export function loadConversationBefore(result: SearchResult, cursor: ConversationPreviewCursor, options?: { limit?: number; dbPath?: string }) {
  debug.time("preview:query:before-page")
  const db = getDb(options?.dbPath)
  const limit = options?.limit ?? 20
  const fetchLimit = Math.max(limit * 4, limit + 1, 30)
  const rows = db.query<ConversationRow, [string, number, number, string, number]>(`
    SELECT p.id, p.message_id, p.session_id,
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.type') AS type,
           p.time_created, p.data
    FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ?
      AND (p.time_created < ? OR (p.time_created = ? AND p.id < ?))
    ORDER BY p.time_created DESC, p.id DESC
    LIMIT ?
  `).all(result.sessionID, cursor.timeCreated, cursor.timeCreated, cursor.id, fetchLimit)
  const valid = rows.filter(isPreviewRow)
  const parts = valid.slice(0, limit).reverse().flatMap((row) => parseConversationPart(row, false) ?? [])
  const page = { parts, hasMoreBefore: valid.length > limit }
  debug.log("preview:window", {
    item: result.id,
    session: result.sessionID,
    mode: "before",
    cursor,
    limit,
    rows: rows.length,
    parts: parts.length,
    hasMoreBefore: page.hasMoreBefore,
    first: parts[0]?.id,
    last: parts.at(-1)?.id,
  })
  debug.timeEnd("preview:query:before-page")
  return page
}

export function loadConversationAfter(result: SearchResult, cursor: ConversationPreviewCursor, options?: { limit?: number; dbPath?: string }) {
  debug.time("preview:query:after-page")
  const db = getDb(options?.dbPath)
  const limit = options?.limit ?? 20
  const fetchLimit = Math.max(limit * 4, limit + 1, 30)
  const rows = db.query<ConversationRow, [string, number, number, string, number]>(`
    SELECT p.id, p.message_id, p.session_id,
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.type') AS type,
           p.time_created, p.data
    FROM part p
    JOIN message m ON m.id = p.message_id
    WHERE p.session_id = ?
      AND (p.time_created > ? OR (p.time_created = ? AND p.id > ?))
    ORDER BY p.time_created ASC, p.id ASC
    LIMIT ?
  `).all(result.sessionID, cursor.timeCreated, cursor.timeCreated, cursor.id, fetchLimit)
  const valid = rows.filter(isPreviewRow)
  const parts = valid.slice(0, limit).flatMap((row) => parseConversationPart(row, false) ?? [])
  const page = { parts, hasMoreAfter: valid.length > limit }
  debug.log("preview:window", {
    item: result.id,
    session: result.sessionID,
    mode: "after",
    cursor,
    limit,
    rows: rows.length,
    parts: parts.length,
    hasMoreAfter: page.hasMoreAfter,
    first: parts[0]?.id,
    last: parts.at(-1)?.id,
  })
  debug.timeEnd("preview:query:after-page")
  return page
}

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
  }
}

export function extractSearchText(data: string) {
  try {
    return extractFromValue(JSON.parse(data)).replace(/\s+/g, " ").trim()
  } catch {
    return data.replace(/\s+/g, " ").trim()
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

function normalizeSnippetSegment(value: string) {
  return value.replace(/\s+/g, " ")
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

function parseConversationPart(row: ConversationRow, target: boolean): ConversationPreviewPart | undefined {
  const data = parsePartData(row.data)
  if (!data) return
  if (row.type === "tool") {
    return {
      id: row.id,
      messageID: row.message_id,
      sessionID: row.session_id,
      role: row.role,
      type: row.type,
      timeCreated: row.time_created,
      text: "",
      tool: typeof data.tool === "string" ? data.tool : "tool",
      state: parseToolState(data.state),
      target,
    }
  }
  const text = typeof data.text === "string" ? data.text.trim() : ""
  if (!text) return
  return {
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    role: row.role,
    type: row.type,
    timeCreated: row.time_created,
    text,
    target,
  }
}

function isPreviewRow(row: ConversationRow) {
  return (row.role === "user" || row.role === "assistant") &&
    (row.type === "text" || row.type === "reasoning" || row.type === "tool")
}

function parsePartData(data: string) {
  try {
    const value = JSON.parse(data) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Record<string, unknown>
  } catch {
    return
  }
}

function parseToolState(value: unknown): ToolState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const state = value as Record<string, unknown>
  if (!["pending", "running", "completed", "error"].includes(String(state.status))) return
  return {
    status: state.status as ToolState["status"],
    input: state.input,
    output: typeof state.output === "string" ? state.output : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
  }
}

function searchRows(db: Database, dbPath: string, query: string, limit: number, directory?: string, offset?: number, role?: SearchRole) {
  if (!tableExists(db, "part") || !tableExists(db, "message")) return []
  debug.time("query:sql")
  const rows = indexedTextRows(db, dbPath, limit, query, directory, offset, role) ?? visibleTextRows(db, limit, query, directory, offset, role)
  debug.timeEnd("query:sql")
  debug.time("query:map")
  const results = rows.flatMap((row) => rowToSearchResult(row, query) ?? [])
  debug.timeEnd("query:map")
  return results
}

function indexedTextRows(db: Database, dbPath: string, limit: number, query: string, directory?: string, offset?: number, role?: SearchRole) {
  const match = ftsQuery(query)
  if (!match) return []
  try {
    const index = ensureSearchIndex(db, dbPath)
    const conditions = ["document_fts MATCH ?"]
    const params: (string | number)[] = [match]
    if (role) {
      conditions.push("role = ?")
      params.push(role)
    }
    if (directory) {
      conditions.push("directory = ?")
      params.push(directory)
    }
    params.push(limit)
    if (offset) params.push(offset)
    const offsetClause = offset ? "OFFSET ?" : ""
    debug.time("query:fts:exec")
    const rows = index.query<Row, (string | number)[]>(`
      SELECT id, message_id, session_id, session_title, directory, role,
             CAST(time_created AS INTEGER) AS time_created, text
      FROM document_fts
      WHERE ${conditions.join(" AND ")}
      ORDER BY bm25(document_fts), CAST(time_created AS INTEGER) DESC
      LIMIT ? ${offsetClause}
    `).all(...params as any[])
    debug.timeEnd("query:fts:exec")
    return rows
  } catch (err) {
    debug.log("fts:fallback", err instanceof Error ? err.message : String(err))
    return
  }
}

function visibleTextRows(db: Database, limit: number, query?: string, directory?: string, offset?: number, role?: SearchRole) {
  const offsetClause = offset ? "OFFSET ?" : ""
  const conditions: string[] = [
    "json_extract(p.data, '$.type') = 'text'",
    role ? "json_extract(m.data, '$.role') = ?" : "json_extract(m.data, '$.role') IN ('user', 'assistant')",
  ]
  const params: (string | number)[] = []

  if (role) params.push(role)

  if (directory) {
    conditions.push("s.directory = ?")
    params.push(directory)
  }

  const tokens = query ? query.trim().split(/\s+/).filter(Boolean) : []
  for (const token of tokens) {
    conditions.push("json_extract(p.data, '$.text') LIKE ?")
    params.push(`%${token}%`)
  }

  params.push(limit)
  if (offset) params.push(offset)

  const sql = `
    SELECT p.id, p.message_id, p.session_id, s.title AS session_title, s.directory,
           json_extract(m.data, '$.role') AS role,
           p.time_created,
           json_extract(p.data, '$.text') AS text
    FROM part p
    JOIN message m ON m.id = p.message_id
    JOIN session s ON s.id = p.session_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY p.time_created DESC
    LIMIT ? ${offsetClause}
  `
  debug.time("query:sql:exec")
  const rows = db.query<Row, (string | number)[]>(sql).all(...params as any[])
  debug.timeEnd("query:sql:exec")
  return rows
}

function ensureSearchIndex(source: Database, sourcePath: string) {
  const indexPath = searchIndexPath(sourcePath)
  if (!_indexDb || _indexDbPath !== indexPath) {
    _indexDb?.close()
    _indexDb = new Database(indexPath)
    _indexDbPath = indexPath
    migrateSearchIndex(_indexDb)
  }

  const state = sourceState(source, sourcePath)
  const currentDataVersion = getMeta(_indexDb, "source_data_version")
  const currentMtimeMs = getMeta(_indexDb, "source_mtime_ms")
  const currentPath = getMeta(_indexDb, "source_path")
  if (currentPath !== sourcePath || currentDataVersion !== String(state.dataVersion) || currentMtimeMs !== String(state.mtimeMs)) {
    rebuildSearchIndex(source, _indexDb, sourcePath, state)
  }
  return _indexDb
}

function searchIndexPath(sourcePath: string) {
  const parsed = path.parse(sourcePath)
  return path.join(parsed.dir, `${parsed.name}-search.db`)
}

function migrateSearchIndex(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
      id UNINDEXED,
      message_id UNINDEXED,
      session_id UNINDEXED,
      session_title,
      directory UNINDEXED,
      role UNINDEXED,
      time_created UNINDEXED,
      text,
      tokenize='unicode61'
    );
  `)
}

function sourceState(db: Database, sourcePath: string) {
  const stat = statSync(sourcePath)
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
  return { dataVersion, mtimeMs: stat.mtimeMs }
}

function rebuildSearchIndex(source: Database, index: Database, sourcePath: string, state: { dataVersion: number; mtimeMs: number }) {
  debug.time("fts:rebuild")
  const rows = source.query<Row, []>(`
    SELECT p.id, p.message_id, p.session_id, s.title AS session_title, s.directory,
           json_extract(m.data, '$.role') AS role,
           p.time_created,
           json_extract(p.data, '$.text') AS text
    FROM part p
    JOIN message m ON m.id = p.message_id
    JOIN session s ON s.id = p.session_id
    WHERE json_extract(p.data, '$.type') = 'text'
      AND json_extract(m.data, '$.role') IN ('user', 'assistant')
      AND json_extract(p.data, '$.text') IS NOT NULL
    ORDER BY p.time_created DESC
  `).all()
  const insert = index.query<Row, [string, string, string, string, string, string, number, string]>(`
    INSERT INTO document_fts(id, message_id, session_id, session_title, directory, role, time_created, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  index.exec("BEGIN IMMEDIATE")
  try {
    index.exec("DELETE FROM document_fts")
    for (const row of rows) {
      insert.run(
        row.id,
        row.message_id,
        row.session_id,
        row.session_title ?? "Untitled session",
        row.directory,
        row.role,
        row.time_created,
        row.text,
      )
    }
    setMeta(index, "source_path", sourcePath)
    setMeta(index, "source_data_version", String(state.dataVersion))
    setMeta(index, "source_mtime_ms", String(state.mtimeMs))
    index.exec("COMMIT")
  } catch (err) {
    index.exec("ROLLBACK")
    throw err
  } finally {
    debug.timeEnd("fts:rebuild")
  }
}

function ftsQuery(query: string) {
  const tokens = query.trim().split(/\s+/)
    .map((token) => token.replace(/["*^:()]/g, " ").trim())
    .filter(Boolean)
  if (!tokens.length) return ""
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ")
}

function getMeta(db: Database, key: string) {
  return db.query<{ value: string }, [string]>("SELECT value FROM index_meta WHERE key = ?").get(key)?.value
}

function setMeta(db: Database, key: string, value: string) {
  db.query<unknown, [string, string]>(`
    INSERT INTO index_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

const tableCache = new Map<string, boolean>()
function tableExists(db: Database, name: string) {
  if (tableCache.has(name)) return tableCache.get(name)!
  const exists = Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  tableCache.set(name, exists)
  return exists
}

function defaultDataDir() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode")
  return path.join(homedir(), ".local", "share", "opencode")
}

function candidateDataDirs() {
  return [
    defaultDataDir(),
    path.join(homedir(), ".local", "share", "opencode"),
    process.platform === "darwin" ? path.join(homedir(), "Library", "Application Support", "opencode") : undefined,
    process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "opencode") : undefined,
  ].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index)
}

function candidateDatabasePaths(names: string[]) {
  return candidateDataDirs().flatMap((dir) => names.map((name) => path.join(dir, name)))
}

function requireExistingDatabase(names: string[]) {
  return candidateDatabasePaths(names).find(existsSync) ?? candidateDatabasePaths(names)[0]!
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

function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return `${value.slice(0, length - 3)}...`
}
