import { describe, expect, test } from "bun:test"
import { checkEmbeddingServer, checkSqliteVec, checkCustomSqlite } from "./dependencies.ts"

describe("dependency checks", () => {
  test("checkEmbeddingServer returns unavailable when fetch fails", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("fetch failed") }
    try {
      const result = await checkEmbeddingServer("http://localhost:1")
      expect(result.state).toBe("unavailable")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("checkSqliteVec returns unavailable without a path", () => {
    const result = checkSqliteVec()
    expect(result.state).toBe("unavailable")
    expect(result.message).toContain("sqlite-vec")
  })

  test("checkSqliteVec returns unavailable for nonexistent path", () => {
    const result = checkSqliteVec("/nonexistent/vec.so")
    expect(result.state).toBe("unavailable")
    expect(result.message).toContain("/nonexistent/vec.so")
  })

  test("checkCustomSqlite returns unavailable without a path", () => {
    const result = checkCustomSqlite()
    expect(result.state).toBe("unavailable")
  })

  test("checkCustomSqlite returns unavailable for nonexistent path", () => {
    const result = checkCustomSqlite("/nonexistent/libsqlite.dylib")
    expect(result.state).toBe("unavailable")
    expect(result.message).toContain("/nonexistent/libsqlite.dylib")
  })
})
