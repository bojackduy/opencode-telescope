import { describe, expect, test } from "bun:test"
import { clippedText, containsOrderedTokens, conversationMatch, filetype, matchExcerpt, parseApplyPatchFiles, shortPath } from "./preview-utils.ts"

describe("containsOrderedTokens", () => {
  test("matches tokens in order", () => {
    expect(containsOrderedTokens("let me test this", "let me")).toBe(true)
    expect(containsOrderedTokens("let me test this", "test this")).toBe(true)
  })

  test("matches with gaps between tokens", () => {
    expect(containsOrderedTokens("let us now test me please", "let me")).toBe(true)
  })

  test("rejects out-of-order tokens", () => {
    expect(containsOrderedTokens("me let", "let me")).toBe(false)
  })

  test("returns false for empty query", () => {
    expect(containsOrderedTokens("hello", "")).toBe(false)
    expect(containsOrderedTokens("hello", "   ")).toBe(false)
  })

  test("is case insensitive", () => {
    expect(containsOrderedTokens("HELLO WORLD", "hello world")).toBe(true)
  })
})

describe("clippedText", () => {
  test("returns full text when under threshold", () => {
    const result = clippedText("short text", "text", 10)
    expect(result.clipped).toBe(false)
    expect(result.text).toBe("short text")
  })

  test("clips large text without match line", () => {
    const large = "line\n".repeat(500)
    const result = clippedText(large, "nonexistent", 10)
    expect(result.clipped).toBe(true)
    expect(result.text.split("\n").length).toBeLessThan(30)
  })

  test("clips large text around match line", () => {
    const lines: string[] = []
    for (let i = 0; i < 500; i++) lines.push(`line ${i}`)
    lines[250] = "needle here"
    const result = clippedText(lines.join("\n"), "needle", 10)
    expect(result.clipped).toBe(true)
    expect(result.text).toContain("needle")
    expect(result.text).toContain("lines omitted")
  })
})

describe("matchExcerpt", () => {
  test("returns snippet around match", () => {
    const text = "a ".repeat(50) + "needle here" + " b".repeat(50)
    const result = matchExcerpt(text, "needle")
    expect(result).toBeDefined()
    expect(result!.match).toContain("needle")
    expect(result!.before).toContain("...")
    expect(result!.after).toContain("...")
  })

  test("returns undefined for empty query", () => {
    expect(matchExcerpt("hello", "")).toBeUndefined()
    expect(matchExcerpt("hello", "   ")).toBeUndefined()
  })

  test("returns undefined when query not found", () => {
    expect(matchExcerpt("hello world", "missing")).toBeUndefined()
  })
})

describe("conversationMatch", () => {
  test("finds match in text", () => {
    const result = conversationMatch("hello world", true, "world")
    expect(result).toEqual({ start: 6, end: 11 })
  })

  test("returns undefined when target is false", () => {
    expect(conversationMatch("hello", false, "hello")).toBeUndefined()
  })

  test("returns undefined when match is empty", () => {
    expect(conversationMatch("hello", true, "")).toBeUndefined()
  })

  test("returns undefined when no match found", () => {
    expect(conversationMatch("hello", true, "world")).toBeUndefined()
  })
})

describe("parseApplyPatchFiles", () => {
  test("parses valid metadata", () => {
    const metadata = {
      files: [
        { filePath: "/project/src/index.ts", patch: "diff content", type: "update", deletions: 0 },
      ],
    }
    const result = parseApplyPatchFiles(metadata)
    expect(result).toHaveLength(1)
    expect(result[0]!.filePath).toBe("/project/src/index.ts")
    expect(result[0]!.relativePath).toBe("/project/src/index.ts")
    expect(result[0]!.patch).toBe("diff content")
  })

  test("returns empty for missing or invalid metadata", () => {
    expect(parseApplyPatchFiles(null)).toEqual([])
    expect(parseApplyPatchFiles({})).toEqual([])
    expect(parseApplyPatchFiles({ files: "not-array" })).toEqual([])
  })

  test("skips entries with missing required fields", () => {
    const metadata = {
      files: [
        { filePath: "/a.ts", patch: "diff" },
        { filePath: "/b.ts" },
        { patch: "diff" },
      ],
    }
    const result = parseApplyPatchFiles(metadata)
    expect(result).toHaveLength(1)
    expect(result[0]!.filePath).toBe("/a.ts")
  })
})

describe("shortPath", () => {
  test("returns last 3 segments", () => {
    expect(shortPath("/project/src/components/Button.tsx")).toBe("src/components/Button.tsx")
  })

  test("handles short paths", () => {
    expect(shortPath("file.ts")).toBe("file.ts")
  })

  test("returns default for empty path", () => {
    expect(shortPath("")).toBe("file")
  })
})

describe("filetype", () => {
  test("maps known extensions", () => {
    expect(filetype("file.ts")).toBe("typescript")
    expect(filetype("file.tsx")).toBe("typescript")
    expect(filetype("file.py")).toBe("python")
    expect(filetype("file.go")).toBe("go")
    expect(filetype("file.rs")).toBe("rust")
    expect(filetype("file.md")).toBe("markdown")
    expect(filetype("file.json")).toBe("json")
    expect(filetype("file.sh")).toBe("shellscript")
  })

  test("returns 'none' for empty or unknown", () => {
    expect(filetype("file")).toBe("none")
    expect(filetype("file.unknown")).toBe("unknown")
  })

  test("is case insensitive", () => {
    expect(filetype("file.TS")).toBe("typescript")
    expect(filetype("file.MD")).toBe("markdown")
  })
})
