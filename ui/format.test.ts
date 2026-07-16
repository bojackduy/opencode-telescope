import { describe, expect, test } from "bun:test"
import { compactTime, markdownWithMatch, roleColor, roleLabel, syntaxStyle, toolIcon, toolInputSummary, toolLabel, truncate } from "./format.ts"

describe("format utils", () => {
  const mockTheme = {
    info: "#00aaff",
    primary: "#ff6600",
    text: "#cccccc",
    textMuted: "#666666",
    accent: "#ffffff",
    background: "#1a1a1a",
    backgroundPanel: "#222222",
    backgroundElement: "#2a2a2a",
    error: "#ff4444",
    warning: "#ffaa00",
    success: "#44cc44",
    markdownHeading: "#ffaa00",
    markdownStrong: "#ffffff",
    markdownEmph: "#cccccc",
    markdownListItem: "#cccccc",
    markdownBlockQuote: "#888888",
    markdownCode: "#44aaff",
    markdownLink: "#44aaff",
    markdownLinkText: "#ffaa00",
    markdownText: "#cccccc",
    syntaxComment: "#6a9955",
    syntaxString: "#ce9178",
    syntaxNumber: "#b5cea8",
    syntaxKeyword: "#569cd6",
    syntaxType: "#4ec9b0",
    syntaxFunction: "#dcdcaa",
    syntaxOperator: "#d4d4d4",
    syntaxVariable: "#9cdcfe",
    syntaxPunctuation: "#d4d4d4",
    diffAdded: "#44cc44",
    diffRemoved: "#ff4444",
    diffContext: "#888888",
    diffAddedBg: "#003300",
    diffRemovedBg: "#330000",
    diffContextBg: "#222222",
    diffHighlightAdded: "#66ff66",
    diffHighlightRemoved: "#ff6666",
    diffLineNumber: "#666666",
    diffAddedLineNumberBg: "#003300",
    diffRemovedLineNumberBg: "#330000",
  }

  test("compactTime formats timestamp", () => {
    const t = new Date("2024-03-15T14:30:00").getTime()
    const result = compactTime(t)
    expect(result).toContain("Mar")
    expect(result).toContain("15")
    expect(result).toMatch(/(14:30|02:30)/)
  })

  test("roleLabel returns correct labels", () => {
    expect(roleLabel("user")).toBe("you")
    expect(roleLabel("assistant")).toBe("assistant")
  })

  test("roleColor returns correct colors", () => {
    expect(roleColor("assistant", mockTheme as never)).toBe(mockTheme.info as never)
    expect(roleColor("user", mockTheme as never)).toBe(mockTheme.primary as never)
  })

  test("toolIcon returns correct symbols", () => {
    expect(toolIcon("bash")).toBe("$")
    expect(toolIcon("read")).toBe("R")
    expect(toolIcon("grep")).toBe("G")
    expect(toolIcon("glob")).toBe("*")
    expect(toolIcon("write")).toBe("W")
    expect(toolIcon("edit")).toBe("W")
    expect(toolIcon("apply_patch")).toBe("W")
    expect(toolIcon("task")).toBe("T")
    expect(toolIcon("todowrite")).toBe("☑")
    expect(toolIcon("webfetch")).toBe("@")
    expect(toolIcon("websearch")).toBe("@")
    expect(toolIcon("skill")).toBe("S")
    expect(toolIcon("question")).toBe("?")
    expect(toolIcon("unknown")).toBe("⚙")
    expect(toolIcon(undefined)).toBe("⚙")
  })

  test("toolLabel returns tool name or default", () => {
    expect(toolLabel("bash")).toBe("bash")
    expect(toolLabel(undefined)).toBe("tool")
  })

  test("toolInputSummary extracts common fields", () => {
    expect(toolInputSummary({ command: "npm test" })).toBe("npm test")
    expect(toolInputSummary({ filePath: "src/index.ts" })).toBe("src/index.ts")
    expect(toolInputSummary({ pattern: "*.ts" })).toBe("*.ts")
    expect(toolInputSummary({})).toBe("{}")
    expect(toolInputSummary(null)).toBe("")
    expect(toolInputSummary("string")).toBe("")
    expect(toolInputSummary(42)).toBe("")
    expect(toolInputSummary({ unknown: "x".repeat(200) })).toHaveLength(90)
  })

  test("markdownWithMatch highlights when match and highlight flag set", () => {
    expect(markdownWithMatch("before ", "match", " after", true))
      .toBe("before **match** after")
    expect(markdownWithMatch("before ", "match", " after", false))
      .toBe("before match after")
    expect(markdownWithMatch("text", "", "", true))
      .toBe("text")
  })

  test("syntaxStyle returns a SyntaxStyle instance", () => {
    const style = syntaxStyle(mockTheme as never)
    expect(style).toBeDefined()
    expect(typeof style).toBe("object")
  })

  test("truncate handles short and long strings", () => {
    expect(truncate("hello", 10)).toBe("hello")
    expect(truncate("hello world", 8)).toBe("hello w…")
    expect(truncate("", 5)).toBe("")
  })
})
