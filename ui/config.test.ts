import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { defaultTelescopeConfig, loadTelescopeConfig, parseTelescopeConfig, telescopeConfigPath } from "./config.ts"

describe("telescope config", () => {
  test("uses defaults for missing config", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-config-"))
    try {
      expect(loadTelescopeConfig(path.join(dir, "missing.json"))).toEqual(defaultTelescopeConfig)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses defaults for invalid json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-config-"))
    const file = path.join(dir, "config.json")
    try {
      writeFileSync(file, "{")
      expect(loadTelescopeConfig(file)).toEqual(defaultTelescopeConfig)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("merges valid partial config and ignores invalid fields", () => {
    const config = parseTelescopeConfig({
      openKey: " <leader>s ",
      keys: {
        moveDown: ["n", 1, ""],
        moveUp: [],
        open: "ctrl+o",
      },
    })

    expect(config.openKey).toBe("<leader>s")
    expect(config.keys.moveDown).toEqual(["n"])
    expect(config.keys.moveUp).toEqual(defaultTelescopeConfig.keys.moveUp)
    expect(config.keys.open).toEqual(["ctrl+o"])
    expect(config.keys.close).toEqual(defaultTelescopeConfig.keys.close)
  })

  test("resolves config under XDG_CONFIG_HOME", () => {
    expect(telescopeConfigPath({ XDG_CONFIG_HOME: "/tmp/config" })).toBe("/tmp/config/opencode/opencode-telescope/config.json")
  })
})
