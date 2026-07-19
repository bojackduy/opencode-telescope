import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import type { Row, ScoredRow, SemanticConfig } from "./types.ts"
import { LlamaEmbeddingClient } from "./embedding.ts"
import { setMeta, getMeta } from "./schema.ts"
import { debug } from "../ui/debug.ts"

export function hybridBlend(keyword: Row[], vector: Row[], alpha: number): ScoredRow[] {
  const merged = new Map<string, ScoredRow>()
  const defaultScore = 0.5

  for (const [i, row] of keyword.entries()) {
    merged.set(row.id, {
      ...row,
      score: 0,
      keywordScore: keyword.length > 1 ? 1 - i / (keyword.length - 1) : 1,
      vectorScore: 0,
    })
  }

  for (const [i, row] of vector.entries()) {
    const existing = merged.get(row.id)
    const vectorScore = vector.length > 1 ? 1 - i / (vector.length - 1) : 1
    if (existing) {
      existing.vectorScore = vectorScore
    } else {
      merged.set(row.id, {
        ...row,
        score: 0,
        keywordScore: defaultScore,
        vectorScore,
      })
    }
  }

  const keywordValues = [...merged.values()].map((r) => r.keywordScore)
  const vectorValues = [...merged.values()].map((r) => r.vectorScore)
  const kwMin = Math.min(...keywordValues)
  const kwMax = Math.max(...keywordValues)
  const vecMin = Math.min(...vectorValues)
  const vecMax = Math.max(...vectorValues)

  const normalized = [...merged.values()].map((r) => {
    const kn = kwMax === kwMin ? 0.5 : (r.keywordScore - kwMin) / (kwMax - kwMin)
    const vn = vecMax === vecMin ? 0.5 : (r.vectorScore - vecMin) / (vecMax - vecMin)
    return {
      ...r,
      keywordScore: kn,
      vectorScore: vn,
      score: (1 - alpha) * kn + alpha * vn,
    }
  })

  return normalized.sort((a, b) => b.score - a.score)
}

export function searchVector(index: Database, embedding: Float32Array, limit: number): Row[] {
  const count = index.query<{ count: number }, []>("SELECT COUNT(*) as count FROM document_vec").get()?.count ?? 0
  if (!count) return []
  const k = Math.min(count, Math.max(limit * 4, 200))
  return index.query<Row, [Float32Array, number]>(`
    SELECT d.part_id AS id, d.message_id, d.session_id, d.session_title, d.directory, d.role,
           d.part_type, d.tool, CAST(d.time_created AS INTEGER) AS time_created, d.text
    FROM document_vec v
    JOIN document d ON d.rowid = v.rowid
    WHERE v.embedding MATCH vec_f32(?) AND k = ?
    ORDER BY v.distance
  `).all(embedding, k)
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

const vectorRebuilds = new Map<string, Promise<void>>()

export function setupVectorTable(index: Database, config: SemanticConfig, indexPath: string): void {
  const dims = getMeta(index, "embedding_dimensions")
  if (dims) {
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

async function rebuildVectorIndex(indexPath: string, config: SemanticConfig) {
  configureCustomSQLite()
  const db = new Database(indexPath)
  try {
    const loaded = await loadVecExtension(db)
    if (!loaded) {
      setMeta(db, "vector_state", "unavailable")
      return
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
      return
    }

    const docs = db.query<{ rowid: number; text: string }, []>("SELECT rowid, text FROM document ORDER BY rowid ASC").all()
    if (!docs.length) {
      setMeta(db, "vector_state", "enabled")
      return
    }

    const truncate = (text: string) => text.length > 800 ? text.slice(0, 800) : text

    const batchSize = 128
    const embeddings: Float32Array[] = []
    debug.log("vector:embed:start", { count: docs.length, batchSize })
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize)
      const batchEmbeddings = await client.embedDocuments(batch.map((d) => truncate(d.text)))
      embeddings.push(...batchEmbeddings)
      debug.log("vector:embed:progress", { done: Math.min(i + batchSize, docs.length), total: docs.length })
    }
    const dims = embeddings[0]?.length
    if (!dims) {
      setMeta(db, "vector_state", "unavailable")
      return
    }

    db.exec("DROP TABLE IF EXISTS document_vec")
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_vec USING vec0(embedding float[${dims}])`)
    debug.log("vector:table:recreated", { dimensions: dims })

    const insert = db.prepare<unknown, [number, Float32Array]>("INSERT INTO document_vec(rowid, embedding) VALUES (?, vec_f32(?))")
    const transaction = db.transaction(() => {
      for (const [i, doc] of docs.entries()) {
        insert.run(doc.rowid, embeddings[i])
      }
    })
    transaction()

    setMeta(db, "vector_state", "enabled")
    setMeta(db, "embedding_dimensions", String(dims))
    if (config.embedModel) setMeta(db, "embedding_model", config.embedModel)
    debug.log("vector:rebuild:done", { vectors: docs.length, dimensions: dims })
  } catch (err) {
    setMeta(db, "vector_state", "unavailable")
    debug.log("vector:rebuild:error", err instanceof Error ? err.message : String(err))
  } finally {
    db.close()
  }
}

export async function loadVecExtension(db: Database): Promise<boolean> {
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

  const config = parseSemanticConfigForVector()
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
  return {
    disableVector: process.env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "1" || process.env.OPENCODE_TELESCOPE_DISABLE_VECTOR === "true",
    sqliteLibPath: process.env.OPENCODE_TELESCOPE_SQLITE_LIB || undefined,
    sqliteVecExtension: process.env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT || undefined,
    embedBaseUrl: process.env.OPENCODE_TELESCOPE_EMBED_BASE_URL ?? "http://127.0.0.1:8081",
    embedModel: process.env.OPENCODE_TELESCOPE_EMBED_MODEL || undefined,
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  }
}
