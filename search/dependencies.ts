import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

export type DependencyState = "available" | "unavailable" | "disabled"

export type DependencyStatus = {
  state: DependencyState
  message: string
}

export function checkEmbeddingServer(baseUrl: string): Promise<DependencyStatus> {
  return checkEmbeddingServerInner(baseUrl)
}

async function checkEmbeddingServerInner(baseUrl: string): Promise<DependencyStatus> {
  for (const endpoint of ["/health", "/v1/health"]) {
    try {
      const response = await fetch(new URL(endpoint, baseUrl), { signal: AbortSignal.timeout(3000) })
      if (response.ok) return { state: "available", message: "embedding server is reachable" }
    } catch {
      continue
    }
  }
  return { state: "unavailable", message: "embedding server did not respond on any health endpoint" }
}

export function checkSqliteVec(sqliteVecPath?: string): DependencyStatus {
  if (!sqliteVecPath && !process.env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT) {
    return { state: "unavailable", message: "no vec0 extension path configured" }
  }
  const resolved = sqliteVecPath ?? process.env.OPENCODE_TELESCOPE_SQLITE_VEC_EXT!
  if (!existsSync(resolved)) {
    return { state: "unavailable", message: `vec0 extension not found at: ${resolved}` }
  }
  try {
    const db = new Database(":memory:")
    db.loadExtension(resolved)
    db.close()
    return { state: "available", message: `vec0 extension loaded from: ${resolved}` }
  } catch (err) {
    return { state: "unavailable", message: `vec0 extension failed to load: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function checkCustomSqlite(libPath?: string): DependencyStatus {
  const candidate = libPath
    ?? process.env.OPENCODE_TELESCOPE_SQLITE_LIB
    ?? (process.platform === "darwin" ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib" : undefined)
  if (!candidate) {
    return { state: "unavailable", message: "no custom SQLite library path available" }
  }
  if (!existsSync(candidate)) {
    return { state: "unavailable", message: `custom SQLite library not found at: ${candidate}` }
  }
  try {
    if (Database.setCustomSQLite(candidate)) {
      return { state: "available", message: `custom SQLite set to: ${candidate}` }
    }
    return { state: "unavailable", message: "Database.setCustomSQLite returned false" }
  } catch (err) {
    return { state: "unavailable", message: `Database.setCustomSQLite failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
