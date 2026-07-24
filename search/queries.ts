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
  KeywordIndexState,
  SearchResponse,
  VectorState,
} from "./types.ts"
import { rowToSearchResult, rowToVectorResult, indexSourceRowToRows, ftsQuery, expandQuery } from "./text.ts"
import { parseSearchQuery, type ParsedSearchQuery, type SearchQueryClause } from "./query.ts"
import { resolveDatabasePath, searchIndexPath } from "./db-path.ts"
import { LlamaEmbeddingClient } from "./embedding.ts"
import { migrateSearchIndex, getMeta, setMeta, SEARCH_INDEX_VERSION, DOCUMENT_EXTRACTOR_VERSION } from "./schema.ts"
import { hybridBlend, searchVector, configureCustomSQLite, loadVecExtension, isVectorReady } from "./vector.ts"

// Load custom SQLite before any Database() constructor runs,
// otherwise Database.setCustomSQLite() fails with "SQLite already loaded"
configureCustomSQLite()

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
  }
  return _db
}

export function searchSessionMessages(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  return searchSessionMessagesWithStatus(query, options).results
}

export function searchSessionMessagesWithStatus(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): SearchResponse {
  const parsed = parseSearchQuery(query)
  if (!parsed.term) return searchResponse([], "ready")
  if (options?.dbPath === ":memory:") return searchResponse([], "missing")
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  const index = openSearchIndex(dbPath)
  const status = readKeywordIndexState(db, index, dbPath)
  const rows = canQueryKeywordIndex(status.state) ? queryFtsRows(index, parsed, options?.limit ?? 80, options?.directory, options?.offset, options?.role) : []
  return searchResponse(rows.flatMap((row) => rowToSearchResult(row, row.matchTerm ?? parsed.term) ?? []), status.state, getVectorState(index))
}

export function recentSessionMessages(options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }) {
  return recentSessionMessagesWithStatus(options).results
}

export function recentSessionMessagesWithStatus(options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): SearchResponse {
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  if (dbPath === ":memory:") return searchResponse([], "missing")
  const db = getDb(dbPath)
  const limit = options?.limit ?? 40
  const index = openSearchIndex(dbPath)
  const status = readKeywordIndexState(db, index, dbPath)
  const rows = canQueryKeywordIndex(status.state) ? queryRecentRows(index, limit, options?.directory, options?.offset, options?.role) : []
  if (!rows.length && (status.state === "missing" || status.state === "empty" || status.state === "indexing")) {
    debug.log("query:recent:index-pending", { state: status.state, limit, offset: options?.offset ?? 0, directory: options?.directory, role: options?.role })
  }
  return searchResponse(rows.flatMap((row) => rowToSearchResult(row, "") ?? []), status.state, getVectorState(index))
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
  return (await performSearchWithStatus(query, options)).results
}

export async function performSearchWithStatus(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): Promise<SearchResponse> {
  if (!query.trim()) return searchSessionMessagesWithStatus(query, options)
  const config = parseSemanticConfig()
  if (!config.disableVector) {
    try {
      return await semanticSearchSessionMessagesWithStatus(query, options)
    } catch {
      debug.log("query:hybrid:fallback", { message: "hybrid search failed, falling back to keyword" })
    }
  }
  return searchSessionMessagesWithStatus(query, options)
}

export async function semanticSearchSessionMessages(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): Promise<SearchResult[]> {
  return (await semanticSearchSessionMessagesWithStatus(query, options)).results
}

export async function semanticSearchSessionMessagesWithStatus(query: string, options?: { limit?: number; offset?: number; dbPath?: string; directory?: string; role?: SearchRole }): Promise<SearchResponse> {
  const parsed = parseSearchQuery(query)
  if (!parsed.term) return searchResponse([], "ready")
  if (options?.dbPath === ":memory:") return searchResponse([], "missing")
  const dbPath = options?.dbPath ?? resolveDatabasePath()
  const db = getDb(dbPath)
  const limit = options?.limit ?? 80
  const offset = options?.offset ?? 0
  const dir = options?.directory
  const role = options?.role

  const index = openSearchIndex(dbPath)
  const status = readKeywordIndexState(db, index, dbPath)
  const config = parseSemanticConfig()
  const useHybridWindow = !parsed.explicitScope && !config.disableVector && isVectorReady(index)
  const windowLimit = useHybridWindow ? Math.max(limit + offset, 200) : limit
  const keyword = canQueryKeywordIndex(status.state) ? queryFtsRows(index, parsed, windowLimit, dir, useHybridWindow ? undefined : offset, role) : []
  let vectorState = getVectorState(index)

  let vector: Row[] = []
  if (useHybridWindow) {
    try {
      const indexPath = searchIndexPath(dbPath)
      await withDeadline(vecExtensionLoading.get(indexPath) ?? Promise.resolve(), 250)
      const embedTerm = expandQuery(parsed.term)
      const embedding = await withDeadline(embedQuery(config, embedTerm), 1200)
      vector = searchVector(index, embedding, windowLimit, { directory: dir, role, kinds: ["user", "assistant"] })
      debug.log("query:vector:results", { count: vector.length, embedTerm: embedTerm !== parsed.term ? embedTerm : undefined })
    } catch (err) {
      debug.log("query:vector:error", err instanceof Error ? err.message : String(err))
      vectorState = getVectorState(index)
    }
  }

  const merged = keyword.length || vector.length
    ? hybridBlend(keyword, vector, config.hybridAlpha)
    : []

  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const row of merged) {
    const result = rowToSearchResult(row, row.matchTerm ?? parsed.term) ?? rowToVectorResult(row, row.vectorScore)
    if (result) {
      seen.add(row.id)
      results.push(result)
    }
  }

  for (const row of vector) {
    if (!seen.has(row.id)) {
      const result = rowToSearchResult(row, row.matchTerm ?? parsed.term) ?? rowToVectorResult(row)
      if (result) results.push(result)
    }
  }

  const start = useHybridWindow ? offset : 0
  return searchResponse(results.slice(start, start + limit), status.state, vectorState)
}

function searchResponse(results: SearchResult[], keywordState: KeywordIndexState, vectorState?: VectorState): SearchResponse {
  return {
    results,
    keywordState,
    vectorState,
    stale: keywordState === "stale",
  }
}

function canQueryKeywordIndex(state: KeywordIndexState) {
  return state === "ready" || state === "stale"
}

function getVectorState(index: Database): VectorState {
  const state = getMeta(index, "vector_state")
  if (state === "enabled" || state === "disabled" || state === "unavailable" || state === "stale" || state === "indexing") return state
  return "unavailable"
}

async function embedQuery(config: SemanticConfig, query: string) {
  const client = new LlamaEmbeddingClient({
    baseUrl: config.embedBaseUrl,
    model: config.embedModel,
    documentPrefix: config.documentPrefix,
    queryPrefix: config.queryPrefix,
  })
  return client.embedQuery(query)
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type KeywordIndexStatus = {
  state: KeywordIndexState
  rowCount: number
}

export function openSearchIndex(sourcePath: string) {
  const indexPath = searchIndexPath(sourcePath)
  if (!_indexDb || _indexDbPath !== indexPath) {
    _indexDb?.close()
    configureCustomSQLite()
    _indexDb = new Database(indexPath)
    _indexDbPath = indexPath
    migrateSearchIndex(_indexDb)
    vecExtensionLoading.set(indexPath, loadVecExtension(_indexDb).then(() => {}).catch(() => {}))
  }
  return _indexDb
}

export function readKeywordIndexState(source: Database, index: Database, sourcePath: string): KeywordIndexStatus {
  try {
    const rowCount = index.query<{ count: number }, []>("SELECT COUNT(*) as count FROM document_index").get()?.count ?? 0
    const storedState = getMeta(index, "keyword_index_state")
    if (storedState === "indexing" && rowCount === 0) return { state: "indexing", rowCount }
    if (storedState === "error" && rowCount === 0) return { state: "error", rowCount }
    if (rowCount === 0) return { state: "empty", rowCount }

    const state = sourceState(source, sourcePath)
    const currentDataVersion = getMeta(index, "source_data_version")
    const currentMtimeMs = getMeta(index, "source_mtime_ms")
    const currentPath = getMeta(index, "source_path")
    const currentIndexVersion = getMeta(index, "index_version")
    const stale = currentPath !== sourcePath || currentDataVersion !== String(state.dataVersion) || currentMtimeMs !== String(state.mtimeMs) || currentIndexVersion !== SEARCH_INDEX_VERSION
    return { state: stale ? "stale" : "ready", rowCount }
  } catch (err) {
    debug.log("keyword:index:state-error", err instanceof Error ? err.message : String(err))
    return { state: "error", rowCount: 0 }
  }
}

type MatchedRow = Row & {
  rank: number
  matchTerm: string
  clauseIndex: number
  clauseRowIndex: number
}

function queryFtsRows(index: Database, query: ParsedSearchQuery, limit: number, directory?: string, offset?: number, role?: SearchRole): MatchedRow[] {
  const clauses = query.clauses.filter((clause) => clause.term.trim())
  if (!clauses.length) return []
  if (clauses.length === 1) return queryFtsClause(index, clauses[0]!, limit, directory, offset, role, query.explicitScope, 0)

  const fetchLimit = limit + (offset ?? 0)
  const merged = new Map<string, MatchedRow>()
  for (const [clauseIndex, clause] of clauses.entries()) {
    for (const row of queryFtsClause(index, clause, fetchLimit, directory, undefined, role, query.explicitScope, clauseIndex)) {
      const existing = merged.get(row.id)
      if (!existing || row.rank < existing.rank || (row.rank === existing.rank && row.time_created > existing.time_created)) {
        merged.set(row.id, row)
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => a.rank - b.rank || b.time_created - a.time_created || a.clauseIndex - b.clauseIndex || a.clauseRowIndex - b.clauseRowIndex)
    .slice(offset ?? 0, (offset ?? 0) + limit)
}

function queryFtsClause(index: Database, clause: SearchQueryClause, limit: number, directory?: string, offset?: number, role?: SearchRole, hasExplicitScope = false, clauseIndex = 0) {
  const match = ftsQuery(clause.term)
  if (!match) return []
  const conditions = ["document_fts MATCH ?"]
  const params: (string | number)[] = [match]
  if (clause.kind) {
    conditions.push("kind = ?")
    params.push(clause.kind)
  }
  if (clause.tool) {
    conditions.push("tool = ?")
    params.push(clause.tool)
  }
  if (!clause.kind && !clause.tool) {
    conditions.push("kind IN ('user', 'assistant')")
  }
  if (role && !hasExplicitScope) {
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
  const rows = index.query<Row & { rank: number }, (string | number)[]>(`
    SELECT id, message_id, session_id, session_title, directory, kind, role, part_type, tool,
           CAST(time_created AS INTEGER) AS time_created, text, bm25(document_fts) AS rank
    FROM document_fts
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank, CAST(time_created AS INTEGER) DESC
    LIMIT ? ${offsetClause}
  `).all(...params as any[])
  debug.timeEnd("query:fts:exec")
  return rows.map((row, clauseRowIndex) => ({ ...row, matchTerm: clause.term, clauseIndex, clauseRowIndex }))
}

function queryRecentRows(index: Database, limit: number, directory?: string, offset?: number, role?: SearchRole) {
  const conditions: string[] = ["kind IN ('user', 'assistant')"]
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
    SELECT id, message_id, session_id, session_title, directory, kind, role, part_type, tool,
           CAST(time_created AS INTEGER) AS time_created, text
    FROM document_index
    ${where}
    ORDER BY CAST(time_created AS INTEGER) DESC
    LIMIT ? ${offsetClause}
  `).all(...params as any[])
  debug.timeEnd("query:recent:index:exec")
  return rows
}

export function rebuildKeywordIndexForDbPath(dbPath: string) {
  const source = getDb(dbPath)
  const index = openSearchIndex(dbPath)
  const state = sourceState(source, dbPath)
  rebuildKeywordIndex(source, index, dbPath, state)
}

function sourceState(db: Database, sourcePath: string) {
  const stat = statSync(sourcePath)
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0
  return { dataVersion, mtimeMs: stat.mtimeMs }
}

function hashPartData(value: { session_id: string; message_id: string; part_id: string }) {
  return createHash("sha256").update(`${value.session_id}:${value.message_id}:${value.part_id}`).digest("hex")
}

export function rebuildKeywordIndex(source: Database, index: Database, sourcePath: string, state: { dataVersion: number; mtimeMs: number }) {
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
        OR json_extract(p.data, '$.type') = 'reasoning'
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
  const insertDoc = index.query<unknown, [string, string, string, string, string, string, string, string, string, string | null, number, number, string, string, string, number]>(`
    INSERT INTO document(doc_id, part_id, message_id, session_id, session_title, directory, kind, role, part_type, tool, time_created, chunk_index, text, source_hash, extractor_version, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertFts = index.query<Row, [string, string, string, string, string, string, string, SearchResult["partType"], string | null, number, string]>(`
    INSERT INTO document_fts(id, message_id, session_id, session_title, directory, kind, role, part_type, tool, time_created, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertIndex = index.query<Row, [string, string, string, string, string, string, string, SearchResult["partType"], string | null, number, string]>(`
    INSERT INTO document_index(id, message_id, session_id, session_title, directory, kind, role, part_type, tool, time_created, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  index.exec("BEGIN IMMEDIATE")
  try {
    setMeta(index, "keyword_index_state", "indexing")
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
        row.kind ?? "assistant",
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
        row.kind ?? "assistant",
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
        row.kind ?? "assistant",
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
    setMeta(index, "keyword_index_state", "ready")
    setMeta(index, "embedding_base_url", config.embedBaseUrl)
    setMeta(index, "document_prefix", config.documentPrefix)
    setMeta(index, "query_prefix", config.queryPrefix)
    if (config.embedModel) setMeta(index, "embedding_model", config.embedModel)
    index.exec("COMMIT")
  } catch (err) {
    index.exec("ROLLBACK")
    setMeta(index, "keyword_index_state", "error")
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

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

export function parseSemanticConfig(env: Record<string, string | undefined> = process.env): SemanticConfig {
  const vectorEnabled = env.OPENCODE_TELESCOPE_ENABLE_VECTOR === "1" || env.OPENCODE_TELESCOPE_ENABLE_VECTOR === "true"
  return {
    embedBaseUrl: env.OPENCODE_TELESCOPE_EMBED_BASE_URL ?? "http://127.0.0.1:8081",
    embedModel: env.OPENCODE_TELESCOPE_EMBED_MODEL || undefined,
    disableVector: !vectorEnabled || env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "1" || env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "true",
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
