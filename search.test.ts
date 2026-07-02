import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  extractSearchText,
  loadConversationAfter,
  loadConversationAround,
  loadConversationBefore,
  makeSnippet,
  recentSessionMessages,
  rowToSearchResult,
  searchSessionMessages,
  type SearchResult,
} from "./search"

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

  test("builds match excerpts without duplicating match text", () => {
    const result = rowToSearchResult(
      {
        id: "prt_1",
        message_id: "msg_1",
        session_id: "ses_1",
        session_title: "Test",
        directory: "/tmp/project",
        role: "assistant",
        time_created: 1,
        text: "Scoped search for help returns relevant rows.",
      },
      "help",
    )
    expect(`${result?.before}${result?.match}${result?.after}`).toBe("Scoped search for help returns relevant rows.")
  })

  test("drops rows whose parsed text does not match", () => {
    expect(
      rowToSearchResult(
        {
          id: "prt_1",
          message_id: "msg_1",
          session_id: "ses_1",
          session_title: "Test",
          directory: "/tmp/project",
          role: "user",
          time_created: 1,
          text: "hello",
        },
        "missing",
      ),
    ).toBeUndefined()
  })

  test("matches multi-token queries in order (contiguous)", () => {
    const result = rowToSearchResult(
      {
        id: "prt_2",
        message_id: "msg_2",
        session_id: "ses_2",
        session_title: "Test",
        directory: "/tmp/project",
        role: "assistant",
        time_created: 2,
        text: "let me test this function",
      },
      "let me",
    )
    expect(result).toBeDefined()
    expect(result!.match).toBe("let me")
    expect(result!.before).not.toContain("let")
    expect(result!.after).toContain("test")
  })

  test("matches multi-token queries with words between (ordered gap)", () => {
    const result = rowToSearchResult(
      {
        id: "prt_3",
        message_id: "msg_3",
        session_id: "ses_3",
        session_title: "Test",
        directory: "/tmp/project",
        role: "assistant",
        time_created: 3,
        text: "let us now test me please",
      },
      "let me",
    )
    expect(result).toBeDefined()
    expect(result!.match).toBe("let us now test me")
  })

  test("rejects multi-token queries when tokens are out of order", () => {
    expect(
      rowToSearchResult(
        {
          id: "prt_4",
          message_id: "msg_4",
          session_id: "ses_4",
          session_title: "Test",
          directory: "/tmp/project",
          role: "user",
          time_created: 4,
          text: "me let",
        },
        "let me",
      ),
    ).toBeUndefined()
  })

  test("makeSnippet works with multi-token queries", () => {
    const text = "a ".repeat(50) + "let me test" + " b".repeat(50)
    const snippet = makeSnippet(text, "let me")
    expect(snippet).toContain("let")
    expect(snippet).toContain("me")
  })

  test("searches through the FTS sidecar and rebuilds after source changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Test", dir)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_2", "Other", path.join(dir, "other"))
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_2", "ses_2", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_3", "ses_1", JSON.stringify({ role: "user" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "needle alpha" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_3", "msg_2", "ses_2", 3, JSON.stringify({ type: "text", text: "needle gamma" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_4", "msg_3", "ses_1", 4, JSON.stringify({ type: "text", text: "needle user" }))

      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_4", "prt_1"])
      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_1"])
      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10, role: "user" }).map((item) => item.id)).toEqual(["prt_4"])

      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_2", "msg_1", "ses_1", 2, JSON.stringify({ type: "text", text: "second beta" }))

      expect(searchSessionMessages("second", { dbPath, limit: 10 }).map((item) => item.id)).toEqual(["prt_2"])
      expect(recentSessionMessages({ dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_4", "prt_2", "prt_1"])
      expect(recentSessionMessages({ dbPath, directory: dir, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_2", "prt_1"])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("searches code snippets stored in apply_patch metadata", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-patch-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Patch Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_patch", "msg_1", "ses_1", 1, JSON.stringify({
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {
              patchText: "*** Begin Patch\n+const validateForSubmit = () => true\n*** End Patch",
            },
            metadata: {
              files: [{
                filePath: path.join(dir, "src/service.ts"),
                relativePath: "src/service.ts",
                type: "update",
                patch: "Index: src/service.ts\n@@\n+const validateForSubmit = () => true",
                deletions: 0,
              }],
            },
          },
        }))

      const results = searchSessionMessages("validateForSubmit", { dbPath, directory: dir, limit: 10 })
      expect(results.map((item) => item.id)).toEqual(["prt_patch"])
      expect(results[0]?.text).toContain("validateForSubmit")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("paginates apply_patch FTS rows without post-filtering raw parts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-patch-page-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Patch Page Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      const insert = db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
      for (let index = 0; index < 35; index++) {
        insert.run(`prt_patch_${index}`, "msg_1", "ses_1", index, JSON.stringify({
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {},
            metadata: {
              files: [{
                filePath: path.join(dir, `src/service-${index}.ts`),
                relativePath: `src/service-${index}.ts`,
                type: "update",
                patch: `Index: src/service-${index}.ts\n@@\n+const paginatedPatchNeedle${index} = true`,
                deletions: 0,
              }],
            },
          },
        }))
      }

      const first = searchSessionMessages("paginatedPatchNeedle", { dbPath, directory: dir, limit: 10 })
      const second = searchSessionMessages("paginatedPatchNeedle", { dbPath, directory: dir, limit: 10, offset: 10 })
      expect(first).toHaveLength(10)
      expect(second).toHaveLength(10)
      expect(first[0]?.id).toBe("prt_patch_34")
      expect(second[0]?.id).toBe("prt_patch_24")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses a Telescope-owned sidecar instead of OpenCode's search db", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-sidecar-"))
    const dbPath = path.join(dir, "opencode.db")
    const conflictingSearchPath = path.join(dir, "opencode-search.db")
    const db = new Database(dbPath)
    const conflict = new Database(conflictingSearchPath)
    try {
      conflict.exec(`
        CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE document(rowid INTEGER PRIMARY KEY, title TEXT, directory TEXT, path TEXT, role TEXT, part_type TEXT, text TEXT);
        CREATE VIRTUAL TABLE document_fts USING fts5(
          title,
          directory,
          path,
          role,
          part_type,
          text,
          content='document',
          content_rowid='rowid'
        );
      `)

      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Patch Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_patch", "msg_1", "ses_1", 1, JSON.stringify({
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {},
            metadata: {
              files: [{
                filePath: path.join(dir, "src/service.ts"),
                relativePath: "src/service.ts",
                type: "update",
                patch: "Index: src/service.ts\n@@\n+const collisionSafePatchNeedle = true",
                deletions: 0,
              }],
            },
          },
        }))

      const results = searchSessionMessages("collisionSafePatchNeedle", { dbPath, directory: dir, limit: 10 })
      expect(results.map((item) => item.id)).toEqual(["prt_patch"])
    } finally {
      conflict.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("filters recent messages by role", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-role-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_2", "ses_1", JSON.stringify({ role: "user" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "assistant text" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_2", "msg_2", "ses_1", 2, JSON.stringify({ type: "text", text: "user text" }))

      expect(recentSessionMessages({ dbPath, limit: 10 }).map((item) => item.id)).toEqual(["prt_2", "prt_1"])
      expect(recentSessionMessages({ dbPath, limit: 10, role: "user" }).map((item) => item.id)).toEqual(["prt_2"])
      expect(recentSessionMessages({ dbPath, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_1"])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads preview pages before and after a matched conversation part", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-preview-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      for (let index = 0; index < 7; index++) {
        db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
          .run(`prt_${index}`, "msg_1", "ses_1", index, JSON.stringify({ type: "text", text: `message ${index}` }))
      }

      const result = previewResult("prt_3", "msg_1", "ses_1", dir, 3)
      const around = loadConversationAround(result, { before: 2, after: 2, dbPath })
      expect(around.parts.map((part) => part.id)).toEqual(["prt_1", "prt_2", "prt_3", "prt_4", "prt_5"])
      expect(around.hasMoreBefore).toBe(true)
      expect(around.hasMoreAfter).toBe(true)

      const before = loadConversationBefore(result, { id: "prt_1", timeCreated: 1 }, { limit: 1, dbPath })
      expect(before.parts.map((part) => part.id)).toEqual(["prt_0"])
      expect(before.hasMoreBefore).toBe(false)

      const after = loadConversationAfter(result, { id: "prt_5", timeCreated: 5 }, { limit: 1, dbPath })
      expect(after.parts.map((part) => part.id)).toEqual(["prt_6"])
      expect(after.hasMoreAfter).toBe(false)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads apply_patch preview text and metadata", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-preview-tool-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Patch Preview", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_patch", "msg_1", "ses_1", 1, JSON.stringify({
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {},
            metadata: {
              files: [{
                filePath: path.join(dir, "src/service.ts"),
                relativePath: "src/service.ts",
                type: "update",
                patch: "Index: src/service.ts\n@@\n+const previewPatchNeedle = true",
                deletions: 0,
              }],
            },
          },
        }))

      const result = previewResult("prt_patch", "msg_1", "ses_1", dir, 1, "tool", "apply_patch", "previewPatchNeedle")
      const around = loadConversationAround(result, { before: 0, after: 0, dbPath })
      expect(around.parts).toHaveLength(1)
      expect(around.parts[0]?.type).toBe("tool")
      expect(around.parts[0]?.tool).toBe("apply_patch")
      expect(around.parts[0]?.text).toContain("previewPatchNeedle")
      expect(around.parts[0]?.state?.metadata).toBeDefined()
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function previewResult(id: string, messageID: string, sessionID: string, directory: string, timeCreated: number, partType: SearchResult["partType"] = "text", tool?: string, match = ""): SearchResult {
  return {
    id,
    messageID,
    sessionID,
    sessionTitle: "Test",
    directory,
    role: "assistant",
    partType,
    tool,
    timeCreated,
    snippet: "",
    matchStart: 0,
    matchEnd: 0,
    before: "",
    match,
    after: "",
    excerpt: "",
    previewBefore: "",
    previewMatch: "",
    previewAfter: "",
    previewMode: "markdown",
    previewHighlight: false,
    text: "",
  }
}
