import { describe, expect, test } from "bun:test"
import { parseSearchQuery, searchQueryLabel } from "./query.ts"

describe("parseSearchQuery", () => {
  test("parses shorthand scope prefixes", () => {
    expect(parseSearchQuery("user:timeout")).toMatchObject({ term: "timeout", kind: "user", explicitScope: true })
    expect(parseSearchQuery("assistant:worker timed out")).toMatchObject({ term: "worker timed out", kind: "assistant", explicitScope: true })
    expect(parseSearchQuery("thought:indexing")).toMatchObject({ term: "indexing", kind: "thought", explicitScope: true })
    expect(parseSearchQuery("patch:SearchResponse")).toMatchObject({ term: "SearchResponse", kind: "patch", explicitScope: true })
  })

  test("parses in scope prefixes", () => {
    expect(parseSearchQuery("in:user timeout")).toMatchObject({ term: "timeout", kind: "user", explicitScope: true })
    expect(parseSearchQuery("in:patch SEARCH_WORKER_TIMEOUT_MS")).toMatchObject({ term: "SEARCH_WORKER_TIMEOUT_MS", kind: "patch", explicitScope: true })
  })

  test("parses tool prefixes", () => {
    expect(parseSearchQuery("tool:apply_patch SearchResponse")).toMatchObject({ term: "SearchResponse", tool: "apply_patch", explicitScope: true })
  })

  test("treats unknown prefixes as plain text", () => {
    expect(parseSearchQuery("url:https://example.com")).toMatchObject({ term: "url:https://example.com", explicitScope: false })
  })

  test("builds display labels", () => {
    expect(searchQueryLabel("patch:SearchResponse")).toBe("match in patch: SearchResponse")
    expect(searchQueryLabel("tool:apply_patch SearchResponse")).toBe("match in tool:apply_patch: SearchResponse")
    expect(searchQueryLabel("SearchResponse")).toBe("match: SearchResponse")
  })
})
