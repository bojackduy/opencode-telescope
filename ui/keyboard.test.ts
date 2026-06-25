import type { ParsedKey } from "@opentui/core"
import { describe, expect, test } from "bun:test"
import { inputSafeKeys, keyListLabel, matchesKey } from "./keyboard.ts"

describe("keyboard helpers", () => {
  test("matches simple key names", () => {
    expect(matchesKey(key("j"), ["j"])).toBe(true)
    expect(matchesKey(key("j"), ["k"])).toBe(false)
  })

  test("matches ctrl modifier strings", () => {
    expect(matchesKey(key("q", { ctrl: true }), ["ctrl+q"])).toBe(true)
    expect(matchesKey(key("q"), ["ctrl+q"])).toBe(false)
  })

  test("labels configured key lists", () => {
    expect(keyListLabel(["ctrl+q"])).toBe("^q")
    expect(keyListLabel(["enter", "return"])).toBe("enter/return")
  })

  test("filters text input unsafe plain character keys", () => {
    expect(inputSafeKeys(["j", "down", "ctrl+j"])).toEqual(["down", "ctrl+j"])
  })
})

function key(name: string, options: Partial<ParsedKey> = {}): ParsedKey {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: "press",
    source: "raw",
    ...options,
  }
}
