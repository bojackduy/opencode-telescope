import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type SearchResult = {
  id: string
  messageID: string
  sessionID: string
  sessionTitle: string
  directory: string
  role: "user" | "assistant"
  timeCreated: number
  snippet: string
  text: string
}

export type PreviewMessage = {
  id: string
  messageID: string
  role: "user" | "assistant"
  text: string
  match: boolean
}

type Row = {
  id: string
  message_id: string
  session_id: string
  session_title: string | null
  directory: string
  role: "user" | "assistant"
  time_created: number
  text: string
}

export function resolveDatabasePath() {
  if (process.env.OPENCODE_DB) {
    if (process.env.OPENCODE_DB === ":memory:" || path.isAbsolute(process.env.OPENCODE_DB)) return process.env.OPENCODE_DB
    return path.join(candidateDataDirs()[0] ?? defaultDataDir(), process.env.OPENCODE_DB)
  }
  if (process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
    return requireExistingDatabase(["opencode.db"])
  }
  const stable = candidateDatabasePaths(["opencode.db"]).find(existsSync)
  if (stable) return stable
  if (process.env.OPENCODE_CHANNEL) {
    const channel = process.env.OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")
    const candidate = candidateDatabasePaths([`opencode-${channel}.db`]).find(existsSync)
    if (candidate) return candidate
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
    return discovered ?? fallback
  } catch {
    return fallback
  }
}

export function searchSessionMessages(query: string, options?: { limit?: number; dbPath?: string; directory?: string }) {
  const term = query.trim()
  if (!term) return []
  if (options?.dbPath === ":memory:") return []
  const db = new Database(options?.dbPath ?? resolveDatabasePath(), { readonly: true })
  try {
    return searchRows(db, term, options?.limit ?? 80, options?.directory)
  } finally {
    db.close()
  }
}

export function recentSessionMessages(options?: { limit?: number; dbPath?: string; directory?: string }) {
  const db = new Database(options?.dbPath ?? resolveDatabasePath(), { readonly: true })
  try {
    return visibleTextRows(db, options?.limit ?? 40, undefined, options?.directory).flatMap(
      (row) => rowToSearchResult(row, "") ?? [],
    )
  } finally {
    db.close()
  }
}

export function loadMessageContext(result: SearchResult, options?: { radius?: number; dbPath?: string }) {
  const db = new Database(options?.dbPath ?? resolveDatabasePath(), { readonly: true })
  try {
    return db
      .query<Row, [string, string, number, number]>(`
        WITH visible AS (
          SELECT p.id, p.message_id, p.session_id, s.title AS session_title,
                 s.directory,
                 json_extract(m.data, '$.role') AS role,
                 p.time_created,
                 json_extract(p.data, '$.text') AS text,
                 row_number() OVER (ORDER BY p.time_created ASC, p.id ASC) AS rn
          FROM part p
          JOIN message m ON m.id = p.message_id
          JOIN session s ON s.id = p.session_id
          WHERE p.session_id = ?
            AND json_extract(p.data, '$.type') = 'text'
            AND json_extract(m.data, '$.role') IN ('user', 'assistant')
        ), hit AS (
          SELECT rn FROM visible WHERE id = ?
        )
        SELECT id, message_id, session_id, session_title, directory, role, time_created, text
        FROM visible
        WHERE rn BETWEEN (SELECT rn FROM hit) - ? AND (SELECT rn FROM hit) + ?
        ORDER BY time_created ASC, id ASC
      `)
      .all(result.sessionID, result.id, options?.radius ?? 3, options?.radius ?? 3)
      .map((row) => ({
        id: row.id,
        messageID: row.message_id,
        role: row.role,
        text: row.text,
        match: row.id === result.id,
      }))
  } finally {
    db.close()
  }
}

export function rowToSearchResult(row: Row, query: string): SearchResult | undefined {
  const text = row.text.replace(/\s+/g, " ").trim()
  if (!text.toLowerCase().includes(query.trim().toLowerCase())) return
  return {
    id: row.id,
    messageID: row.message_id,
    sessionID: row.session_id,
    sessionTitle: row.session_title || "Untitled session",
    directory: row.directory,
    role: row.role,
    timeCreated: row.time_created,
    snippet: makeSnippet(text, query),
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
  const index = haystack.toLowerCase().indexOf(query.trim().toLowerCase())
  if (index === -1) return truncate(haystack, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(haystack.length, index + query.length + radius)
  return `${start > 0 ? "..." : ""}${haystack.slice(start, end)}${end < haystack.length ? "..." : ""}`
}

function searchRows(db: Database, query: string, limit: number, directory?: string) {
  if (!tableExists(db, "part") || !tableExists(db, "message")) return []
  return visibleTextRows(db, limit, query, directory).flatMap((row) => rowToSearchResult(row, query) ?? [])
}

function visibleTextRows(db: Database, limit: number, query?: string, directory?: string) {
  if (query) {
    const input = directory ? [directory, `%${query}%`, limit] satisfies [string, string, number] : [`%${query}%`, limit] satisfies [string, number]
    return db
      .query<Row, [string, string, number] | [string, number]>(`
        SELECT p.id, p.message_id, p.session_id, s.title AS session_title, s.directory,
               json_extract(m.data, '$.role') AS role,
               p.time_created,
               json_extract(p.data, '$.text') AS text
        FROM part p
        JOIN message m ON m.id = p.message_id
        JOIN session s ON s.id = p.session_id
        WHERE json_extract(p.data, '$.type') = 'text'
          AND json_extract(m.data, '$.role') IN ('user', 'assistant')
          ${directory ? "AND s.directory = ?" : ""}
          AND json_extract(p.data, '$.text') LIKE ?
        ORDER BY p.time_created DESC
        LIMIT ?
      `)
      .all(...input)
  }
  const input = directory ? [directory, limit] satisfies [string, number] : [limit] satisfies [number]
  return db
    .query<Row, [string, number] | [number]>(`
      SELECT p.id, p.message_id, p.session_id, s.title AS session_title, s.directory,
             json_extract(m.data, '$.role') AS role,
             p.time_created,
             json_extract(p.data, '$.text') AS text
      FROM part p
      JOIN message m ON m.id = p.message_id
      JOIN session s ON s.id = p.session_id
      WHERE json_extract(p.data, '$.type') = 'text'
        AND json_extract(m.data, '$.role') IN ('user', 'assistant')
        ${directory ? "AND s.directory = ?" : ""}
      ORDER BY p.time_created DESC
      LIMIT ?
    `)
    .all(...input)
}

function tableExists(db: Database, name: string) {
  return Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
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
