import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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

export function searchIndexPath(sourcePath: string) {
  const parsed = path.parse(sourcePath)
  return path.join(parsed.dir, `${parsed.name}-telescope-search.db`)
}

export function candidateDataDirs() {
  return [
    defaultDataDir(),
    path.join(homedir(), ".local", "share", "opencode"),
    process.platform === "darwin" ? path.join(homedir(), "Library", "Application Support", "opencode") : undefined,
    process.platform === "win32" ? path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "opencode") : undefined,
  ].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index)
}

function defaultDataDir() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode")
  return path.join(homedir(), ".local", "share", "opencode")
}

function candidateDatabasePaths(names: string[]) {
  return candidateDataDirs().flatMap((dir) => names.map((name) => path.join(dir, name)))
}

function requireExistingDatabase(names: string[]) {
  return candidateDatabasePaths(names).find(existsSync) ?? candidateDatabasePaths(names)[0]!
}

let cachedDbPath: string | undefined

export function clearDbPathCache() {
  cachedDbPath = undefined
}
