import { Database } from "bun:sqlite"
import { resolveDatabasePath } from "./db-path.ts"
import { parseSearchQuery, type ParsedSearchQuery } from "./query.ts"
import { rowToSearchResult, indexSourceRowToRows } from "./text.ts"
import type { SearchResult, SearchRole, IndexSourceRow } from "./types.ts"
import { debug } from "../ui/debug.ts"

const STREAM_BUCKETS: { label: string; cutoffMs: number; sessions: number }[] = [
  { label: "3d", cutoffMs: 3 * 86400 * 1000, sessions: 8 },
  { label: "7d", cutoffMs: 7 * 86400 * 1000, sessions: 16 },
  { label: "30d", cutoffMs: 30 * 86400 * 1000, sessions: 32 },
  { label: "90d", cutoffMs: 90 * 86400 * 1000, sessions: 48 },
  { label: "all", cutoffMs: 0, sessions: 48 },
]

const MAX_PARTS_PER_MESSAGE = 12
const MAX_CANDIDATES = 200
const MAX_MESSAGES_PER_SESSION = 32

export type StreamBatch = {
  results: SearchResult[]
  bucketLabel: string
  bucketIndex: number
  totalBuckets: number
  isComplete: boolean
}

function nowMs() {
  return Date.now()
}

export function* streamSearchBuckets(
  dbPath: string,
  queryString: string,
  options: { directory?: string; role?: SearchRole; limit?: number } = {},
): Generator<StreamBatch> {
  const parsed = parseSearchQuery(queryString)
  const term = queryString.trim()
  const limit = options.limit ?? 80

  const resolvedPath = dbPath || resolveDatabasePath()
  let db: Database | undefined
  try {
    db = new Database(resolvedPath, { readonly: true })
  } catch {
    yield { results: [], bucketLabel: "db-error", bucketIndex: 0, totalBuckets: 0, isComplete: true }
    return
  }

  if (!tableHasColumn(db, "message", "time_created")) {
    db.close()
    yield { results: [], bucketLabel: "unsupported", bucketIndex: 0, totalBuckets: 0, isComplete: true }
    return
  }

  // Gather sessions once, sorted by recent activity (rowid ≈ insertion order)
  const sessionConditions: string[] = []
  const sessionParams: (string | number)[] = []
  if (options.directory) {
    sessionConditions.push("directory = ?")
    sessionParams.push(options.directory)
  }
  const maxSessionCount = STREAM_BUCKETS.at(-1)!.sessions
  sessionParams.push(maxSessionCount)
  const sessions = db.query<{ id: string; title: string; directory: string }, (string | number)[]>(`
    SELECT id, title, directory
    FROM session
    ${sessionConditions.length ? `WHERE ${sessionConditions.join(" AND ")}` : ""}
    ORDER BY rowid DESC
    LIMIT ?
  `).all(...sessionParams as any[])

  if (sessions.length === 0) {
    db.close()
    yield { results: [], bucketLabel: "no-sessions", bucketIndex: 0, totalBuckets: 0, isComplete: true }
    return
  }

  const effectiveBuckets = term ? STREAM_BUCKETS : [{ label: "recent", cutoffMs: 0, sessions: 16 }]
  const totalBuckets = effectiveBuckets.length

  const globalSeen = new Set<string>()
  let cumulativeCount = 0
  const now = nowMs()

  for (let bucketIndex = 0; bucketIndex < effectiveBuckets.length; bucketIndex++) {
    const bucket = effectiveBuckets[bucketIndex]!
    const bucketResults: SearchResult[] = []

    const cutoffMs = bucket.cutoffMs === 0 ? 0 : Math.max(0, now - bucket.cutoffMs)
    const bucketSessions = sessions.slice(0, bucket.sessions)
    const startTime = performance.now()

    for (const session of bucketSessions) {
      if (bucketResults.length >= MAX_CANDIDATES) break

      // Single joined query: messages + their parts in one round-trip per session
      const timeFilter = "AND m.time_created >= ?"
      const timeParams: (string | number)[] = [session.id, cutoffMs]
      timeParams.push(MAX_MESSAGES_PER_SESSION * MAX_PARTS_PER_MESSAGE)

      const rows = db.query<{
        message_id: string; message_data: string
        part_id: string; part_time: number; part_data: string
      }, (string | number)[]>(`
        SELECT m.id AS message_id, m.data AS message_data,
               p.id AS part_id, p.time_created AS part_time, p.data AS part_data
        FROM message m
        JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? ${timeFilter}
        ORDER BY m.time_created DESC, m.id DESC, p.id DESC
        LIMIT ?
      `).all(...timeParams)

      let lastMessageID = ""
      let lastMessageRole: SearchRole | undefined
      for (const row of rows) {
        if (bucketResults.length >= MAX_CANDIDATES) break
        if (globalSeen.has(row.part_id)) continue

        if (row.message_id !== lastMessageID) {
          lastMessageID = row.message_id
          lastMessageRole = sourceMessageRole(row.message_data)
          if (!lastMessageRole || (options.role && !parsed.explicitScope && lastMessageRole !== options.role)) continue
        } else if (!lastMessageRole) continue

        const metadata = sourcePartMetadata(row.part_data)
        if (!metadata) continue

        const sourceRow: IndexSourceRow = {
          id: row.part_id,
          message_id: row.message_id,
          session_id: session.id,
          session_title: session.title,
          directory: session.directory,
          role: lastMessageRole,
          part_type: metadata.partType,
          tool: metadata.tool,
          time_created: row.part_time,
          data: row.part_data,
        }

        for (const ir of indexSourceRowToRows(sourceRow)) {
          if (globalSeen.has(ir.id)) continue
          const result = streamMatchResult(ir, parsed, options.role)
          if (!result) continue
          globalSeen.add(result.id)
          bucketResults.push(result)
          break // one result per part
        }
      }
    }

    cumulativeCount += bucketResults.length
    const isLast = bucketIndex === totalBuckets - 1 || cumulativeCount >= limit

    debug.log("query:stream-bucket", {
      bucket: bucket.label,
      index: bucketIndex,
      sessions: bucketSessions.length,
      results: bucketResults.length,
      cumulative: cumulativeCount,
      elapsedMs: Number((performance.now() - startTime).toFixed(2)),
      isLast,
    })

    yield {
      results: bucketResults,
      bucketLabel: bucket.label,
      bucketIndex,
      totalBuckets,
      isComplete: isLast,
    }

    if (cumulativeCount >= limit) break
  }

  db.close()
}

function streamMatchResult(
  row: { id: string; role: SearchRole; kind?: string; tool?: string | null; text: string; [key: string]: unknown },
  query: ParsedSearchQuery,
  _roleOverride?: SearchRole | undefined,
) {
  for (const clause of query.clauses) {
    if (clause.kind && row.kind !== clause.kind) continue
    if (clause.tool && row.tool !== clause.tool) continue
    if (!clause.kind && !clause.tool && row.kind !== "user" && row.kind !== "assistant") continue
    const result = rowToSearchResult(row as any, clause.term)
    if (result) return result
  }
}

function tableHasColumn(db: Database, table: string, column: string) {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

function sourceMessageRole(data: string): SearchRole | undefined {
  try {
    const role = (JSON.parse(data) as { role?: unknown }).role
    return role === "user" || role === "assistant" ? role : undefined
  } catch {
    return
  }
}

function sourcePartMetadata(data: string): { partType: SearchResult["partType"]; tool?: string } | undefined {
  try {
    const value = JSON.parse(data) as { type?: unknown; tool?: unknown }
    if (value.type === "text" || value.type === "reasoning") return { partType: value.type }
    if (value.type === "tool" && typeof value.tool === "string" && ["apply_patch", "edit", "write"].includes(value.tool)) {
      return { partType: "tool", tool: value.tool }
    }
  } catch {}
}
