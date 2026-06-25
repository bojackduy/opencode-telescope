import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type TelescopeKeyAction =
  | "moveDown"
  | "moveUp"
  | "scrollPreviewDown"
  | "scrollPreviewUp"
  | "open"
  | "close"
  | "insertMode"
  | "normalMode"
  | "toggleOwner"

export type TelescopeConfig = {
  openKey: string
  keys: Record<TelescopeKeyAction, string[]>
}

export const defaultTelescopeConfig: TelescopeConfig = {
  openKey: "<leader>f",
  keys: {
    moveDown: ["down", "j"],
    moveUp: ["up", "k"],
    scrollPreviewDown: ["d"],
    scrollPreviewUp: ["u"],
    open: ["enter", "return"],
    close: ["q", "escape"],
    insertMode: ["/"],
    normalMode: ["ctrl+q"],
    toggleOwner: ["o"],
  },
}

export function telescopeConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(configHome, "opencode", "opencode-telescope", "config.json")
}

export function loadTelescopeConfig(configPath = telescopeConfigPath()): TelescopeConfig {
  if (!existsSync(configPath)) return cloneConfig(defaultTelescopeConfig)

  try {
    return parseTelescopeConfig(JSON.parse(readFileSync(configPath, "utf8")))
  } catch {
    return cloneConfig(defaultTelescopeConfig)
  }
}

export function parseTelescopeConfig(value: unknown): TelescopeConfig {
  const config = cloneConfig(defaultTelescopeConfig)
  if (!isRecord(value)) return config

  if (typeof value.openKey === "string" && value.openKey.trim()) {
    config.openKey = value.openKey.trim()
  }

  if (!isRecord(value.keys)) return config
  for (const action of Object.keys(defaultTelescopeConfig.keys) as TelescopeKeyAction[]) {
    const parsed = parseKeyList(value.keys[action])
    if (parsed) config.keys[action] = parsed
  }

  return config
}

function parseKeyList(value: unknown) {
  if (typeof value === "string") {
    const key = value.trim()
    return key ? [key] : undefined
  }
  if (!Array.isArray(value)) return

  const keys = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return keys.length > 0 ? keys : undefined
}

function cloneConfig(config: TelescopeConfig): TelescopeConfig {
  return {
    openKey: config.openKey,
    keys: Object.fromEntries(
      Object.entries(config.keys).map(([action, keys]) => [action, [...keys]]),
    ) as Record<TelescopeKeyAction, string[]>,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
