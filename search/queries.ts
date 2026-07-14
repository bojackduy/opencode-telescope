import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { debug } from "../ui/debug.ts"

import type {
  SearchResult,
  SearchRole,
  ConversationPreviewPage,
  ConversationPreviewCursor,
  ConversationRow,
  ConversationPreviewPart,
  IndexSourceRow,
  Row,
  SemanticConfig,
} from "./types.ts"
import { rowToSearchResult, rowToVectorResult, indexSourceRowToRows, ftsQuery } from "./text.ts"
import { resolveDatabasePath, searchIndexPath } from "./db-path.ts"
import { LlamaEmbeddingClient } from "./embedding.ts"
import { migrateSearchIndex, getMeta, setMeta, SEARCH_INDEX_VERSION, DOCUMENT_EXTRACTOR_VERSION } from "./schema.ts"
import { hybridBlend, searchVector, setupVectorTable, configureCustomSQLite, loadVecExtension } from "./vector.ts"

// Load custom SQLite before any Database() constructor runs,
// otherwise Database.setCustomSQLite() fails with "SQLite already loaded"
configureCustomSQLite()

const backgroundIndexRebuilds = new Set<string>()
const lastVectorRebuildAttempt = new Map<string, number>()
const vecExtensionLoading = new Map<string, Promise<void>>()

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

export function searchSessionMessages(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  const term = query.trim()
  if (!term) return []
  if (options?.dbPath === ":memory:") return []
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  return searchRows(db, dbPath, term, options?.limit ?? 80, options?.directory, options?.offset, options?.role)
}

export function recentSessionMessages(options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  const limit = options?.limit ?? 40
  const indexed = dbPath === ":memory:" ? undefined : indexedRecentRows(db, dbPath, limit, options?.directory, options?.offset, options?.role)
  if (indexed) return indexed.flatMap((row) => rowToSearchResult(row, "") ?? [])
  debug.log("query:recent:source-fallback", { limit, offset: options?.offset ?? 0, directory: options?.directory, role: options?.role })
  return visibleTextRows(db, limit, undefined, options?.directory, options?.offset, options?.role).flatMap(
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
    validBefore: validBefore.length,
    invalidBefore: previewRowBreakdown(beforeRows, validBefore),
    afterRows: afterRows.length,
    validAfter: validAfter.length,
    invalidAfter: previewRowBreakdown(afterRows, validAfter),
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
    valid: valid.length,
    invalid: previewRowBreakdown(rows, valid),
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
    valid: valid.length,
    invalid: previewRowBreakdown(rows, valid),
    parts: parts.length,
    hasMoreAfter: page.hasMoreAfter,
    first: parts[0]?.id,
    last: parts.at(-1)?.id,
  })
  debug.timeEnd("preview:query:after-page")
  return page
}

export async function performSearch(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): Promise<SearchResult[]> {
  if (!query.trim()) return searchSessionMessages(query, options)
  const config = parseSemanticConfig()
  if (!config.disableVector) {
    try {
      return await semanticSearchSessionMessages(query, options)
    } catch {
      debug.log("query:hybrid:fallback", { message: "hybrid search failed, falling back to keyword" })
    }
  }
  return searchSessionMessages(query, options)
}

export async function semanticSearchSessionMessages(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): Promise<SearchResult[]> {
  const term = query.trim()
  if (!term) return []
  if (options?.dbPath === ":memory:") return []
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  const limit = options?.limit ?? 80
  const dir = options?.directory
  const role = options?.role

  const index = ensureSearchIndex(db, dbPath)
  if (!index) return []

  const keyword = indexedTextRows(db, dbPath, limit, term, dir, options?.offset, role) ?? []
  const config = parseSemanticConfig()

  let vector: Row[] = []
  if (!config.disableVector) {
    let vecState = getMeta(index, "vector_state")
    if (vecState !== "enabled" && vecState !== "disabled" && vecState !== "stale") {
      const indexPath = searchIndexPath(dbPath)
      const lastAttempt = lastVectorRebuildAttempt.get(indexPath)
      if (!lastAttempt || Date.now() - lastAttempt > 30_000) {
        const probeClient = new LlamaEmbeddingClient({
          baseUrl: config.embedBaseUrl,
          model: config.embedModel,
          documentPrefix: config.documentPrefix,
          queryPrefix: config.queryPrefix,
        })
        try {
          const healthy = await probeClient.health()
          if (healthy) {
            await setupVectorTable(index, config, indexPath)
            lastVectorRebuildAttempt.set(indexPath, Date.now())
            vecState = getMeta(index, "vector_state") ?? "stale"
          }
        } catch {
          vecState = "unavailable"
        }
      }
    }
    if (vecState === "stale" && getMeta(index, "embedding_dimensions")) {
      try {
        const indexPath = searchIndexPath(dbPath)
        await vecExtensionLoading.get(indexPath)
        const test = index.query("SELECT COUNT(*) as count FROM document_vec").get() as { count: number } | undefined
        if (test && test.count > 0) {
          setMeta(index, "vector_state", "enabled")
          vecState = "enabled"
        }
      } catch {
        debug.log("vector:stale:recovery-failed")
      }
    }
    if (vecState === "enabled") {
      try {
        const indexPath = searchIndexPath(dbPath)
        await vecExtensionLoading.get(indexPath)
        const client = new LlamaEmbeddingClient({
          baseUrl: config.embedBaseUrl,
          model: config.embedModel,
          documentPrefix: config.documentPrefix,
          queryPrefix: config.queryPrefix,
        })
        const embedding = await client.embedQuery(term)
        vector = searchVector(index, embedding, limit)
        debug.log("query:vector:results", { count: vector.length })
      } catch (err) {
        debug.log("query:vector:error", err instanceof Error ? err.message : String(err))
      }
    }
  }

  const merged = keyword.length || vector.length
    ? hybridBlend(keyword, vector, config.hybridAlpha)
    : []

  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const row of merged) {
    const result = rowToSearchResult(row, term) ?? rowToVectorResult(row, row.vectorScore)
    if (result) {
      seen.add(row.id)
      results.push(result)
    }
  }

  for (const row of vector) {
    if (!seen.has(row.id)) {
      const result = rowToSearchResult(row, term) ?? rowToVectorResult(row)
      if (result) results.push(result)
    }
  }

  return results
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
    if (!index) return []
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
      SELECT id, message_id, session_id, session_title, directory, role, part_type, tool,
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

function indexedRecentRows(db: Database, dbPath: string, limit: number, directory?: string, offset?: number, role?: SearchRole) {
  try {
    const index = ensureSearchIndex(db, dbPath, { rebuild: false, useStale: true })
    if (!index) {
      debug.log("query:recent:index:missing", { dbPath })
      return
    }

    const rowCount = index.query<{ count: number }, []>("SELECT COUNT(*) as count FROM document_index").get()?.count ?? 0
    if (rowCount === 0) {
      debug.log("query:recent:index:empty", { dbPath })
      return
    }

    const state = sourceState(db, dbPath)
    const currentDataVersion = getMeta(index, "source_data_version")
    const currentMtimeMs = getMeta(index, "source_mtime_ms")
    const currentPath = getMeta(index, "source_path")
    const currentIndexVersion = getMeta(index, "index_version")
    if (currentPath !== dbPath || currentDataVersion !== String(state.dataVersion) || currentMtimeMs !== String(state.mtimeMs) || currentIndexVersion !== SEARCH_INDEX_VERSION) {
      debug.log("query:recent:index:stale", {
        dbPath,
        expectedDataVersion: state.dataVersion,
        actualDataVersion: currentDataVersion,
      })
    }

    const conditions: string[] = ["part_type = 'text'"]
    const params: (string | number)[] = []
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

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
    const offsetClause = offset ? "OFFSET ?" : ""
    debug.time("query:recent:index:exec")
    const rows = index.query<Row, (string | number)[]>(`
      SELECT id, message_id, session_id, session_title, directory, role, part_type, tool,
             CAST(time_created AS INTEGER) AS time_created, text
      FROM document_index
      ${where}
      ORDER BY CAST(time_created AS INTEGER) DESC
      LIMIT ? ${offsetClause}
    `).all(...params as any[])
    debug.timeEnd("query:recent:index:exec")
    return rows
  } catch (err) {
    debug.log("recent:index:fallback", err instanceof Error ? err.message : String(err))
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

function ensureSearchIndex(source: Database, sourcePath: string, options?: { rebuild?: boolean; useStale?: boolean }) {
  const indexPath = searchIndexPath(sourcePath)
  if (!_indexDb || _indexDbPath !== indexPath) {
    _indexDb?.close()
    configureCustomSQLite()
    _indexDb = new Database(indexPath)
    _indexDbPath = indexPath
    migrateSearchIndex(_indexDb)
    vecExtensionLoading.set(indexPath, loadVecExtension(_indexDb).then(() => {}).catch(() => {}))
  }

  const state = sourceState(source, sourcePath)
  const currentDataVersion = getMeta(_indexDb, "source_data_version")
  const currentMtimeMs = getMeta(_indexDb, "source_mtime_ms")
  const currentPath = getMeta(_indexDb, "source_path")
  const currentIndexVersion = getMeta(_indexDb, "index_version")
  if (currentPath !== sourcePath || currentDataVersion !== String(state.dataVersion) || currentMtimeMs !== String(state.mtimeMs) || currentIndexVersion !== SEARCH_INDEX_VERSION) {
    if (options?.rebuild === false) {
      if (options?.useStale) return _indexDb
      return
    }
    rebuildSearchIndex(source, _indexDb, sourcePath, state)
  }
  return _indexDb
}

function scheduleBackgroundIndexRebuild(dbPath: string) {
  if (backgroundIndexRebuilds.has(dbPath)) return
  backgroundIndexRebuilds.add(dbPath)
  debug.log("fts:rebuild:background-scheduled", { dbPath })
  const timer = setTimeout(() => {
    debug.time("fts:rebuild:background")
    try {
      const db = getDb(dbPath)
      ensureSearchIndex(db, dbPath)
    } catch (err) {
      debug.log("fts:rebuild:background:error", err instanceof Error ? err.message : String(err))
    } finally {
      backgroundIndexRebuilds.delete(dbPath)
      debug.timeEnd("fts:rebuild:background")
    }
  }, 250)
  ;(timer as { unref?: () => void }).unref?.()
}

function sourceState(db: Database, sourcePath: string) {
  const stat = statSync(sourcePath)
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
  return { dataVersion, mtimeMs: stat.mtimeMs }
}

function hashPartData(value: { session_id: string; message_id: string; part_id: string }) {
  return createHash("sha256").update(`${value.session_id}:${value.message_id}:${value.part_id}`).digest("hex")
}

function rebuildSearchIndex(source: Database, index: Database, sourcePath: string, state: { dataVersion: number; mtimeMs: number }) {
  debug.time("fts:rebuild")
  const rows = source.query<IndexSourceRow, []>(`
    SELECT p.id, p.message_id, p.session_id, s.title AS session_title, s.directory,
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.type') AS part_type,
           json_extract(p.data, '$.tool') AS tool,
           p.time_created,
           p.data
    FROM part p
    JOIN message m ON m.id = p.message_id
    JOIN session s ON s.id = p.session_id
    WHERE (
        json_extract(p.data, '$.type') = 'text'
        OR (
          json_extract(p.data, '$.type') = 'tool'
          AND json_extract(p.data, '$.tool') IN ('apply_patch', 'edit', 'write')
        )
      )
      AND json_extract(m.data, '$.role') IN ('user', 'assistant')
    ORDER BY p.time_created DESC
  `).all()
  const now = Date.now()
  const config = parseSemanticConfig()
  const insertDoc = index.query<unknown, [string, string, string, string, string, string, string, string, string | null, number, number, string, string, string, number]>(`
    INSERT INTO document(doc_id, part_id, message_id, session_id, session_title, directory, role, part_type, tool, time_created, chunk_index, text, source_hash, extractor_version, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = index.query<Row, [string, string, string, string, string, string, SearchResult["partType"], string | null, number, string]>(`
    INSERT INTO document_fts(id, message_id, session_id, session_title, directory, role, part_type, tool, time_created, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertIndex = index.query<Row, [string, string, string, string, string, string, SearchResult["partType"], string | null, number, string]>(`
    INSERT INTO document_index(id, message_id, session_id, session_title, directory, role, part_type, tool, time_created, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  index.exec("BEGIN IMMEDIATE")
  try {
    index.exec("DELETE FROM document")
    index.exec("DELETE FROM document_fts")
    index.exec("DELETE FROM document_index")
    for (const row of rows.flatMap(indexSourceRowToRows)) {
      const docID = `telescope:${row.session_id}:${row.message_id}:${row.id}:0`
      const sourceHash = hashPartData({ session_id: row.session_id, message_id: row.message_id, part_id: row.id })
      insertDoc.run(
        docID,
        row.id,
        row.message_id,
        row.session_id,
        row.session_title ?? "Untitled session",
        row.directory,
        row.role,
        row.part_type ?? "text",
        row.tool ?? null,
        row.time_created,
        0,
        row.text,
        sourceHash,
        DOCUMENT_EXTRACTOR_VERSION,
        now,
      )
      insertFts.run(
        row.id,
        row.message_id,
        row.session_id,
        row.session_title ?? "Untitled session",
        row.directory,
        row.role,
        row.part_type ?? "text",
        row.tool ?? null,
        row.time_created,
        row.text,
      )
      insertIndex.run(
        row.id,
        row.message_id,
        row.session_id,
        row.session_title ?? "Untitled session",
        row.directory,
        row.role,
        row.part_type ?? "text",
        row.tool ?? null,
        row.time_created,
        row.text,
      )
    }
    setMeta(index, "source_path", sourcePath)
    setMeta(index, "source_data_version", String(state.dataVersion))
    setMeta(index, "source_mtime_ms", String(state.mtimeMs))
    setMeta(index, "index_version", SEARCH_INDEX_VERSION)
    setMeta(index, "schema_version", "2")
    setMeta(index, "extractor_version", DOCUMENT_EXTRACTOR_VERSION)
    setMeta(index, "ranking_version", "1")
    setMeta(index, "embedding_base_url", config.embedBaseUrl)
    setMeta(index, "document_prefix", config.documentPrefix)
    setMeta(index, "query_prefix", config.queryPrefix)
    if (config.embedModel) setMeta(index, "embedding_model", config.embedModel)
    index.exec("COMMIT")
  } catch (err) {
    index.exec("ROLLBACK")
    throw err
  } finally {
    debug.timeEnd("fts:rebuild")
  }

  if (config.disableVector) {
    setMeta(index, "vector_state", "disabled")
  }
}

function isPreviewRow(row: ConversationRow) {
  return (row.role === "user" || row.role === "assistant") &&
    (row.type === "text" || row.type === "reasoning" || row.type === "tool")
}

function previewRowBreakdown(rows: ConversationRow[], validRows: ConversationRow[]) {
  const valid = new Set(validRows.map((row) => row.id))
  const invalidRows = rows.filter((row) => !valid.has(row.id))
  if (invalidRows.length === 0) return undefined
  const byRole = countBy(invalidRows, (row) => String(row.role ?? "unknown"))
  const byType = countBy(invalidRows, (row) => String(row.type ?? "unknown"))
  return { count: invalidRows.length, byRole, byType }
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
      text: target ? extractToolIndexText(data).trim() : "",
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

function parsePartData(data: string) {
  try {
    const value = JSON.parse(data) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    return value as Record<string, unknown>
  } catch {
    return
  }
}

function parseToolState(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const state = value as Record<string, unknown>
  if (!["pending", "running", "completed", "error"].includes(String(state.status))) return
  return {
    status: state.status as "pending" | "running" | "completed" | "error",
    input: state.input,
    metadata: state.metadata,
    output: typeof state.output === "string" ? state.output : undefined,
    error: typeof state.error === "string" ? state.error : undefined,
  }
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

const tableCache = new Map<string, boolean>()
function tableExists(db: Database, name: string) {
  if (tableCache.has(name)) return tableCache.get(name)!
  const exists = Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
  tableCache.set(name, exists)
  return exists
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

export function parseSemanticConfig(env: Record<string, string | undefined> = process.env): SemanticConfig {
  return {
    embedBaseUrl: env.OPENCODE_TELESCOPE_EMBED_BASE_URL ?? "http://127.0.0.1:8081",
    embedModel: env.OPENCODE_TELESCOPE_EMBED_MODEL || undefined,
    disableVector: env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "1" || env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "true",
    sqliteLibPath: env.OPENCODE_TELESCOPE_SQLITE_LIB || undefined,
    sqliteVecExtension: env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT || undefined,
    hybridAlpha: parseAlpha(env.OPENCODE_TELESCOPE_HYBRID_ALPHA),
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  }
}

function parseAlpha(value: string | undefined) {
  if (!value) return 0.45
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0.45
  if (parsed < 0) return 0
  if (parsed > 1) return 1
  return parsed
}
