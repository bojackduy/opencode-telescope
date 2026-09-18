import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import type { Row, ScoredRow, SearchKind, SearchRole, SemanticConfig } from "./types.ts"
import { LlamaEmbeddingClient } from "./embedding.ts"
import { setMeta, getMeta } from "./schema.ts"
import { debug } from "../ui/debug.ts"

export type VectorSearchOptions = {
  offset?: number
  directory?: string
  role?: SearchRole
  kinds?: SearchKind[]
}

export const RRF_K = 60

export function rrfBlend(keyword: Row[], vector: Row[], options?: { k?: number; alpha?: number }): ScoredRow[] {
  const k = options?.k ?? RRF_K
  const alpha = options?.alpha
  const merged = new Map<string, ScoredRow & { rrf: number }>()

  for (const [i, row] of keyword.entries()) {
    const s = 1 / (k + i + 1)
    merged.set(row.id, {
      ...row,
      score: 0,
      keywordScore: s,
      vectorScore: 0,
      rrf: alpha === undefined ? s : (1 - alpha) * s,
    })
  }

  for (const [i, row] of vector.entries()) {
    const s = 1 / (k + i + 1)
    const weighted = alpha === undefined ? s : alpha * s
    const existing = merged.get(row.id)
    if (existing) {
      existing.vectorScore = s
      existing.rrf += weighted
    } else {
      merged.set(row.id, {
        ...row,
        score: 0,
        keywordScore: 0,
        vectorScore: s,
        rrf: weighted,
      })
    }
  }

  // Keyword-only rows keep their RRF weight; vector-only rows keep theirs.
  // No min-max renormalization, so scores are stable across pages/queries.
  return [...merged.values()]
    .map((r) => ({ ...r, score: r.rrf }))
    .sort((a, b) => b.score - a.score || b.time_created - a.time_created)
}

export function hybridBlend(keyword: Row[], vector: Row[], alpha: number): ScoredRow[] {
  // Backward-compatible wrapper: RRF with alpha weighting.
  // alpha=0 -> keyword only, alpha=1 -> vector only, default 0.45.
  if (!keyword.length && !vector.length) return []
  return rrfBlend(keyword, vector, { k: RRF_K, alpha })
}

export function searchVector(index: Database, embedding: Float32Array, limit: number, options: VectorSearchOptions = {}): Row[] {
  let count = 0
  try {
    count = index.query<{ count: number }, []>("SELECT COUNT(*) as count FROM document_vec").get()?.count ?? 0
  } catch {
    return []
  }
  if (!count) return []
  const plan = buildVectorSearchPlan(count, limit, options)
  if (plan.limit <= 0 || plan.k <= 0) return []
  const params: Array<Float32Array | string | number> = [embedding, plan.k, ...plan.params, plan.limit]
  if (plan.offset) params.push(plan.offset)
  const offsetClause = plan.offset ? "OFFSET ?" : ""
  const useDocIdJoin = hasVecMap(index)
  try {
    const rows = useDocIdJoin
      ? index.query<Row, Array<Float32Array | string | number>>(`
        SELECT d.part_id AS id, d.message_id, d.session_id, d.session_title, d.directory, d.kind, d.role,
               d.part_type, d.tool, CAST(d.time_created AS INTEGER) AS time_created, d.text,
               d.chunk_index, d.doc_id
        FROM document_vec v
        JOIN vec_map m ON m.vec_rowid = v.rowid
        JOIN document d ON d.doc_id = m.doc_id
        WHERE v.embedding MATCH vec_f32(?) AND k = ?${plan.where}
        ORDER BY v.distance
        LIMIT ? ${offsetClause}
      `).all(...params as any[])
      : index.query<Row, Array<Float32Array | string | number>>(`
        SELECT d.part_id AS id, d.message_id, d.session_id, d.session_title, d.directory, d.kind, d.role,
               d.part_type, d.tool, CAST(d.time_created AS INTEGER) AS time_created, d.text
        FROM document_vec v
        JOIN document d ON d.rowid = v.rowid
        WHERE v.embedding MATCH vec_f32(?) AND k = ?${plan.where}
        ORDER BY v.distance
        LIMIT ? ${offsetClause}
      `).all(...params as any[])
    // Collapse best-chunk-per-part: chunks share part id, keep lowest distance (first).
    const seen = new Set<string>()
    const deduped: Row[] = []
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      deduped.push(row)
      if (deduped.length >= plan.limit) break
    }
    return deduped
  } catch {
    return []
  }
}

function hasVecMap(index: Database): boolean {
  try {
    index.query("SELECT 1 FROM vec_map LIMIT 1").get()
    return true
  } catch {
    return false
  }
}

export function buildVectorSearchPlan(totalCount: number, limit: number, options: VectorSearchOptions = {}) {
  const conditions: string[] = []
  const params: Array<string | number> = []
  const offset = Math.max(0, options.offset ?? 0)
  const pageLimit = Math.max(0, limit)

  if (options.directory) {
    conditions.push("d.directory = ?")
    params.push(options.directory)
  }
  if (options.role) {
    conditions.push("d.role = ?")
    params.push(options.role)
  }
  if (options.kinds?.length) {
    if (options.kinds.length === 1) {
      conditions.push("d.kind = ?")
      params.push(options.kinds[0]!)
    } else {
      conditions.push(`d.kind IN (${options.kinds.map(() => "?").join(", ")})`)
      params.push(...options.kinds)
    }
  }

  const hasFilters = conditions.length > 0
  const wanted = pageLimit + offset
  // Filtered ANN: avoid full-table k=totalCount scans on large corpora.
  // Over-fetch 20x window (min 500) so post-filter still recalls; unfiltered keeps 4x window.
  const k = hasFilters
    ? Math.min(totalCount, Math.max(wanted * 20, 500))
    : Math.min(totalCount, Math.max(wanted * 4, 200))
  return {
    where: conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
    params,
    k,
    limit: pageLimit,
    offset,
  }
}

export function isVectorReady(index: Database) {
  if (getMeta(index, "vector_state") !== "enabled") return false
  if (!getMeta(index, "embedding_dimensions")) return false
  try {
    index.query("SELECT 1 FROM document_vec LIMIT 1").get()
    return true
  } catch {
    return false
  }
}

export const VECTOR_CHUNKER_VERSION = "2"

export function getEmbeddingVersion(config: SemanticConfig): string {
  return [
    config.embedModel ?? "local-embedding",
    config.documentPrefix,
    config.queryPrefix,
    `chunker:${VECTOR_CHUNKER_VERSION}`,
  ].join("|")
}

export function isVectorVersionStale(index: Database, config: SemanticConfig): boolean {
  const stored = getMeta(index, "embedding_version")
  if (!stored) return true
  return stored !== getEmbeddingVersion(config)
}

export function ensureVecMapTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_map(
      vec_rowid INTEGER PRIMARY KEY,
      doc_id TEXT UNIQUE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vec_map_doc_idx ON vec_map(doc_id);
  `)
}

export type StaleChunk = { doc_id: string; text: string }

export function collectStaleVectorChunks(index: Database, config: SemanticConfig, limit = 2000): { stale: StaleChunk[]; versionStale: boolean } {
  const versionStale = isVectorVersionStale(index, config)
  try {
    ensureVecMapTable(index)
    const rows = index.query<{ doc_id: string; text: string }, [number]>(`
      SELECT d.doc_id AS doc_id, d.text AS text
      FROM document d
      LEFT JOIN vec_map m ON m.doc_id = d.doc_id
      WHERE m.doc_id IS NULL
      ORDER BY d.rowid ASC
      LIMIT ?
    `).all(limit)
    // Content-hash mismatches are handled by delete-then-reinsert in
    // replaceIndexedPart (source_hash changes => old doc_ids removed). Any
    // remaining doc without a vec_map entry needs embedding.
    void versionStale
    return { stale: rows, versionStale }
  } catch {
    return { stale: [], versionStale }
  }
}

export function upsertVectorChunkEmbeddings(index: Database, entries: Array<{ doc_id: string; embedding: Float32Array }>) {
  if (!entries.length) return
  ensureVecMapTable(index)
  const del = index.prepare("DELETE FROM vec_map WHERE doc_id = ?")
  const delVec = (vecRowid: number) => {
    try {
      index.query("DELETE FROM document_vec WHERE rowid = ?").run(vecRowid)
    } catch {}
  }
  const insertVec = index.prepare("INSERT INTO document_vec(embedding) VALUES (vec_f32(?))")
  const insertMap = index.prepare("INSERT INTO vec_map(vec_rowid, doc_id) VALUES (?, ?)")
  const txn = index.transaction(() => {
    for (const entry of entries) {
      const existing = index.query<{ vec_rowid: number }, [string]>("SELECT vec_rowid FROM vec_map WHERE doc_id = ?").get(entry.doc_id)
      if (existing) {
        delVec(existing.vec_rowid)
        del.run(entry.doc_id)
      }
      const info = insertVec.run(entry.embedding as unknown as string) as unknown as { lastInsertRowid: number | bigint }
      const vecRowid = Number((info as { lastInsertRowid: number }).lastInsertRowid)
      insertMap.run(vecRowid, entry.doc_id)
    }
  })
  txn()
}

export function removeVectorChunksForPart(index: Database, sessionId: string, messageId: string, partId: string) {
  try {
    ensureVecMapTable(index)
    const pattern = `telescope:${sessionId}:${messageId}:${partId}:%`
    const rows = index.query<{ vec_rowid: number; doc_id: string }, [string]>(
      "SELECT vec_rowid, doc_id FROM vec_map WHERE doc_id LIKE ? ESCAPE '\\'",
    ).all(pattern)
    if (!rows.length) return
    const delMap = index.prepare("DELETE FROM vec_map WHERE doc_id = ?")
    const txn = index.transaction(() => {
      for (const row of rows) {
        try {
          index.query("DELETE FROM document_vec WHERE rowid = ?").run(row.vec_rowid)
        } catch {}
        delMap.run(row.doc_id)
      }
    })
    txn()
  } catch {}
}

export function removeVectorChunksForDocIds(index: Database, docIds: string[]) {
  if (!docIds.length) return
  try {
    ensureVecMapTable(index)
    const sel = index.prepare("SELECT vec_rowid FROM vec_map WHERE doc_id = ?")
    const del = index.prepare("DELETE FROM vec_map WHERE doc_id = ?")
    const txn = index.transaction(() => {
      for (const docId of docIds) {
        const existing = (sel.get(docId) as unknown as { vec_rowid: number } | undefined)
        if (existing) {
          try {
            index.query("DELETE FROM document_vec WHERE rowid = ?").run(existing.vec_rowid)
          } catch {}
          del.run(docId)
        }
      }
    })
    txn()
  } catch {}
}

const vectorRebuilds = new Map<string, Promise<void>>()

export function setupVectorTable(index: Database, config: SemanticConfig, indexPath: string): void {
  const dims = getMeta(index, "embedding_dimensions")
  if (dims && !isVectorVersionStale(index, config)) {
    try {
      ensureVecMapTable(index)
    } catch {}
    setMeta(index, "vector_state", "enabled")
    debug.log("vector:already-indexed", { dimensions: dims })
    return
  }
  if (vectorRebuilds.has(indexPath)) {
    setMeta(index, "vector_state", "stale")
    debug.log("vector:rebuild:already-running", { indexPath })
    return
  }

  setMeta(index, "vector_state", "stale")
  const rebuild = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      rebuildVectorIndex(indexPath, config)
        .catch((err) => {
          debug.log("vector:rebuild:error", err instanceof Error ? err.message : String(err))
        })
        .finally(resolve)
    }, 1)
    ;(timer as { unref?: () => void }).unref?.()
  }).finally(() => {
    vectorRebuilds.delete(indexPath)
  })
  vectorRebuilds.set(indexPath, rebuild)
}

let customSQLiteConfigured = false

export function configureCustomSQLite() {
  if (customSQLiteConfigured) return
  const config = parseSemanticConfigForVector()
  if (config.disableVector) return
  customSQLiteConfigured = true

  const candidates = [
    config.sqliteLibPath,
    process.platform === "darwin" ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib" : undefined,
    process.platform === "darwin" ? "/usr/local/opt/sqlite/lib/libsqlite3.dylib" : undefined,
  ].filter((item): item is string => Boolean(item))

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        Database.setCustomSQLite(candidate)
        debug.log("custom-sqlite:set", { path: candidate })
        return
      } catch (err) {
        debug.log("custom-sqlite:error", { path: candidate, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

export async function syncVectorIndexForDbPath(indexPath: string, config: SemanticConfig, options?: { batchSize?: number; limit?: number }): Promise<{ embedded: number; total: number; state: string }> {
  configureCustomSQLite()
  const db = new Database(indexPath)
  try {
    const loaded = await loadVecExtension(db)
    if (!loaded) {
      setMeta(db, "vector_state", "unavailable")
      return { embedded: 0, total: 0, state: "unavailable" }
    }
    if (isVectorVersionStale(db, config)) {
      // Model/prefix/chunker changed: drop vectors, keep documents, re-embed incrementally.
      try {
        db.exec("DROP TABLE IF EXISTS document_vec")
      } catch {}
      try {
        db.exec("DELETE FROM vec_map")
      } catch {}
      const dims = getMeta(db, "embedding_dimensions")
      if (dims) {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_vec USING vec0(embedding float[${dims}])`)
      }
      setMeta(db, "vector_state", "indexing")
    }
    const client = new LlamaEmbeddingClient({
      baseUrl: config.embedBaseUrl,
      model: config.embedModel,
      documentPrefix: config.documentPrefix,
      queryPrefix: config.queryPrefix,
    })
    const healthy = await client.health()
    if (!healthy) {
      setMeta(db, "vector_state", "unavailable")
      return { embedded: 0, total: 0, state: "unavailable" }
    }
    const { stale } = collectStaleVectorChunks(db, config, options?.limit ?? 2000)
    if (!stale.length) {
      // Ensure vec table exists even on empty corpus.
      const dims = getMeta(db, "embedding_dimensions")
      if (dims) {
        try {
          db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_vec USING vec0(embedding float[${dims}])`)
        } catch {}
      }
      setMeta(db, "vector_state", "enabled")
      setMeta(db, "embedding_version", getEmbeddingVersion(config))
      return { embedded: 0, total: 0, state: "enabled" }
    }
    setMeta(db, "vector_state", "indexing")
    const batchSize = options?.batchSize ?? 64
    let embedded = 0
    let dims = Number(getMeta(db, "embedding_dimensions") ?? 0)
    debug.log("vector:embed:start", { count: stale.length, batchSize })
    for (let i = 0; i < stale.length; i += batchSize) {
      const batch = stale.slice(i, i + batchSize)
      const batchEmbeddings = await client.embedDocuments(batch.map((d) => d.text))
      if (!dims) {
        dims = batchEmbeddings[0]?.length ?? 0
        if (!dims) {
          setMeta(db, "vector_state", "unavailable")
          return { embedded, total: stale.length, state: "unavailable" }
        }
        try {
          db.exec("DROP TABLE IF EXISTS document_vec")
        } catch {}
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_vec USING vec0(embedding float[${dims}])`)
        setMeta(db, "embedding_dimensions", String(dims))
      }
      upsertVectorChunkEmbeddings(db, batch.map((doc, j) => ({ doc_id: doc.doc_id, embedding: batchEmbeddings[j]! })))
      embedded += batch.length
      debug.log("vector:embed:progress", { done: Math.min(i + batchSize, stale.length), total: stale.length })
    }
    setMeta(db, "vector_state", "enabled")
    setMeta(db, "embedding_version", getEmbeddingVersion(config))
    if (config.embedModel) setMeta(db, "embedding_model", config.embedModel)
    debug.log("vector:rebuild:done", { vectors: embedded, dimensions: dims })
    return { embedded, total: stale.length, state: "enabled" }
  } catch (err) {
    try {
      setMeta(db, "vector_state", "unavailable")
    } catch {}
    debug.log("vector:rebuild:error", err instanceof Error ? err.message : String(err))
    return { embedded: 0, total: 0, state: "unavailable" }
  } finally {
    db.close()
  }
}

async function rebuildVectorIndex(indexPath: string, config: SemanticConfig) {
  await syncVectorIndexForDbPath(indexPath, config)
}

export async function loadVecExtension(db: Database): Promise<boolean> {
  const config = parseSemanticConfigForVector()
  if (config.disableVector) return false

  try {
    const sqliteVec = await importPackage("sqlite-vec").catch(() => undefined)
    if (sqliteVec?.load) {
      sqliteVec.load(db)
      debug.log("vector:extension:loaded", { source: "npm" })
      return true
    }
  } catch {
    debug.log("vector:extension:npm-failed")
  }

  const explicitPath = config.sqliteVecExtension || process.env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT
  if (explicitPath && existsSync(explicitPath)) {
    try {
      db.loadExtension(explicitPath)
      debug.log("vector:extension:loaded", { source: "path", path: explicitPath })
      return true
    } catch (err) {
      debug.log("vector:extension:path-failed", { path: explicitPath, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return false
}

function importPackage(specifier: string) {
  return new Function("specifier", "return import(specifier)")(specifier) as Promise<{ load?: (db: Database) => void; getLoadablePath?: () => string }>
}

function parseSemanticConfigForVector(): { disableVector: boolean; sqliteLibPath?: string; sqliteVecExtension?: string; embedBaseUrl: string; embedModel?: string; documentPrefix: string; queryPrefix: string } {
  const vectorEnabled = process.env.OPENCODE_TELESCOPE_ENABLE_VECTOR === "1" || process.env.OPENCODE_TELESCOPE_ENABLE_VECTOR === "true"
  return {
    disableVector: !vectorEnabled || process.env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "1" || process.env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "true",
    sqliteLibPath: process.env.OPENCODE_TELESCOPE_SQLITE_LIB || undefined,
    sqliteVecExtension: process.env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT || undefined,
    embedBaseUrl: process.env.OPENCODE_TELESCOPE_EMBED_BASE_URL ?? "http://127.0.0.1:8081",
    embedModel: process.env.OPENCODE_TELESCOPE_EMBED_MODEL || undefined,
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  }
}
