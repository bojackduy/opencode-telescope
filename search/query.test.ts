import { describe, expect, test } from "bun:test"
import { parseSearchQuery, searchQueryHint, searchQueryLabel } from "./query.ts"

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

describe("searchQueryHint", () => {
  test("explains bare search for empty and plain queries", () => {
    expect(searchQueryHint("")).toBe("Bare search: user prompts + assistant replies. Try patch:SearchResponse or thought:indexing")
    expect(searchQueryHint("timeout")).toBe("Bare search excludes thoughts and patches. Use thought: or patch: to include them.")
  })

  test("explains shorthand scope prefixes", () => {
    expect(searchQueryHint("user:")).toBe("user:<term> searches only your prompts.")
    expect(searchQueryHint("assistant:")).toBe("assistant:<term> searches only assistant replies.")
    expect(searchQueryHint("thought:")).toBe("thought:<term> searches assistant reasoning/thought parts.")
    expect(searchQueryHint("patch:")).toBe("patch:<term> searches code edits, patches, and changed file names.")
  })

  test("explains in scope prefixes", () => {
    expect(searchQueryHint("in:")).toBe("in:<scope> <term> supports user, assistant, thought, and patch.")
    expect(searchQueryHint("in:user")).toBe("in:user <term> searches only your prompts.")
    expect(searchQueryHint("in:thought")).toBe("in:thought <term> searches assistant reasoning/thought parts.")
    expect(searchQueryHint("in:patch")).toBe("in:patch <term> searches code edits, patches, and changed file names.")
  })

  test("explains tool prefixes", () => {
    expect(searchQueryHint("tool:")).toBe("tool:<name> <term> searches one tool, for example tool:apply_patch SearchResponse.")
    expect(searchQueryHint("tool:apply_patch")).toBe("tool:apply_patch <term> searches apply_patch content.")
  })

  test("explains owner override for scoped queries with a term", () => {
    expect(searchQueryHint("patch:SearchResponse")).toBe("Scoped search overrides the owner toggle.")
    expect(searchQueryHint("in:patch SearchResponse")).toBe("Scoped search overrides the owner toggle.")
    expect(searchQueryHint("tool:apply_patch SearchResponse")).toBe("Scoped search overrides the owner toggle.")
  })
})
