import { describe, expect, test } from "bun:test"
import { extractSearchText, makeSnippet, rowToSearchResult } from "./search"

describe("session search helpers", () => {
  test("extracts user message text", () => {
    expect(extractSearchText(JSON.stringify({ text: "hello validateSession world" }))).toContain("validateSession")
  })

  test("extracts assistant content text", () => {
    expect(
      extractSearchText(
        JSON.stringify({
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "call validateSession before returning" },
          ],
        }),
      ),
    ).toContain("validateSession")
  })

  test("builds focused snippets", () => {
    expect(makeSnippet("a ".repeat(100) + "needle" + " b".repeat(100), "needle")).toContain("needle")
  })

  test("drops rows whose parsed text does not match", () => {
    expect(
      rowToSearchResult(
        {
          id: "prt_1",
          message_id: "msg_1",
          session_id: "ses_1",
          session_title: "Test",
          role: "user",
          time_created: 1,
          text: "hello",
        },
        "missing",
      ),
    ).toBeUndefined()
  })
})
