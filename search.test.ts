import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  extractSearchText,
  ftsQuery,
  hybridBlend,
  loadConversationAfter,
  loadConversationAround,
  loadConversationBefore,
  makeSnippet,
  openSearchIndex,
  parseSemanticConfig,
  performSearch,
  performSearchWithStatus,
  recentSessionMessages,
  rebuildKeywordIndexForDbPath,
  resolveDatabasePath,
  rowToSearchResult,
  rowToVectorResult,
  searchSessionMessages,
  searchSessionMessagesWithStatus,
  searchIndexPath,
  type SearchResult,
} from "./search"
import { setMeta } from "./search/schema.ts"

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

      rebuildKeywordIndexForDbPath(dbPath)
      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_4", "prt_1"])
      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_1"])
      expect(searchSessionMessages("needle", { dbPath, directory: dir, limit: 10, role: "user" }).map((item) => item.id)).toEqual(["prt_4"])

      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_2", "msg_1", "ses_1", 2, JSON.stringify({ type: "text", text: "second beta" }))

      rebuildKeywordIndexForDbPath(dbPath)
      expect(searchSessionMessages("second", { dbPath, limit: 10 }).map((item) => item.id)).toEqual(["prt_2"])
      expect(recentSessionMessages({ dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_4", "prt_2", "prt_1"])
      expect(recentSessionMessages({ dbPath, directory: dir, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_2", "prt_1"])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("typed search returns immediately while sidecar index is pending", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-search-pending-"))
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
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "pendingSearchNeedle" }))

      const response = searchSessionMessagesWithStatus("pendingSearchNeedle", { dbPath, directory: dir, limit: 10 })
      expect(response.keywordState).toBe("empty")
      expect(response.results).toEqual([])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("typed search returns stale sidecar rows without scanning source", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-search-stale-"))
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
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_old", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "staleSearchNeedle old" }))

      rebuildKeywordIndexForDbPath(dbPath)
      setMeta(openSearchIndex(dbPath), "source_path", `${dbPath}.old`)
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_new", "msg_1", "ses_1", 2, JSON.stringify({ type: "text", text: "staleSearchNeedle new" }))

      const response = searchSessionMessagesWithStatus("staleSearchNeedle", { dbPath, directory: dir, limit: 10 })
      expect(response.keywordState).toBe("stale")
      expect(response.results.map((item) => item.id)).toEqual(["prt_old"])
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

      rebuildKeywordIndexForDbPath(dbPath)
      const results = searchSessionMessages("validateForSubmit", { dbPath, directory: dir, limit: 10 })
      expect(results.map((item) => item.id)).toEqual(["prt_patch"])
      expect(results[0]?.text).toContain("validateForSubmit")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("supports explicit scoped search filters", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-scoped-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Scoped Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_user", "ses_1", JSON.stringify({ role: "user" }))
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_assistant", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_user", "msg_user", "ses_1", 1, JSON.stringify({ type: "text", text: "scopeNeedle from user" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_assistant", "msg_assistant", "ses_1", 2, JSON.stringify({ type: "text", text: "scopeNeedle from assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_thought", "msg_assistant", "ses_1", 3, JSON.stringify({ type: "reasoning", text: "scopeNeedle from thought" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_patch", "msg_assistant", "ses_1", 4, JSON.stringify({
          type: "tool",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: { patchText: "*** Begin Patch\n+const scopeNeedle = true\n*** End Patch" },
            metadata: {},
          },
        }))

      rebuildKeywordIndexForDbPath(dbPath)

      expect(searchSessionMessages("user:scopeNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_user"])
      expect(searchSessionMessages("assistant:scopeNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_assistant"])
      expect(searchSessionMessages("thought:scopeNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_thought"])
      expect(searchSessionMessages("patch:scopeNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_patch"])
      expect(searchSessionMessages("tool:apply_patch scopeNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_patch"])
      expect(searchSessionMessages("tool:edit scopeNeedle", { dbPath, directory: dir, limit: 10 })).toEqual([])
      expect(searchSessionMessages("user:scopeNeedle", { dbPath, directory: dir, limit: 10, role: "assistant" }).map((item) => item.id)).toEqual(["prt_user"])

      const patchResult = searchSessionMessages("patch:scopeNeedle", { dbPath, directory: dir, limit: 10 })[0]
      expect(patchResult?.match).toBe("scopeNeedle")
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("migrates old sidecar tables without kind column before searching", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-old-kind-"))
    const dbPath = path.join(dir, "opencode.db")
    const indexPath = searchIndexPath(dbPath)
    const db = new Database(dbPath)
    let index: Database | undefined = new Database(indexPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Old Sidecar", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "oldKindNeedle" }))

      index.exec(`
        CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE document(
          rowid INTEGER PRIMARY KEY,
          doc_id TEXT UNIQUE NOT NULL,
          part_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          session_title TEXT NOT NULL,
          directory TEXT NOT NULL,
          role TEXT NOT NULL,
          part_type TEXT NOT NULL,
          tool TEXT,
          time_created INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          text TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          extractor_version TEXT NOT NULL,
          indexed_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE document_fts USING fts5(
          id UNINDEXED,
          message_id UNINDEXED,
          session_id UNINDEXED,
          session_title,
          directory UNINDEXED,
          role UNINDEXED,
          part_type UNINDEXED,
          tool UNINDEXED,
          time_created UNINDEXED,
          text,
          tokenize='unicode61'
        );
        CREATE TABLE document_index(
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          session_title TEXT NOT NULL,
          directory TEXT NOT NULL,
          role TEXT NOT NULL,
          part_type TEXT NOT NULL,
          tool TEXT,
          time_created INTEGER NOT NULL,
          text TEXT NOT NULL
        );
      `)
      index.close()
      index = undefined

      expect(searchSessionMessages("oldKindNeedle", { dbPath, directory: dir, limit: 10 })).toEqual([])
      rebuildKeywordIndexForDbPath(dbPath)
      expect(searchSessionMessages("oldKindNeedle", { dbPath, directory: dir, limit: 10 }).map((item) => item.id)).toEqual(["prt_1"])
    } finally {
      index?.close()
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

      rebuildKeywordIndexForDbPath(dbPath)
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

      rebuildKeywordIndexForDbPath(dbPath)
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

      rebuildKeywordIndexForDbPath(dbPath)
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

  test("recent messages returns immediately while sidecar index is pending", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-recent-pending-"))
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
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "assistant text" }))

      expect(recentSessionMessages({ dbPath, limit: 10 })).toEqual([])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recent messages does not source-scan when stale sidecar misses active directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-recent-stale-dir-"))
    const dbPath = path.join(dir, "opencode.db")
    const oldDir = path.join(dir, "old")
    const currentDir = path.join(dir, "current")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_old", "Old", oldDir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_old", "ses_old", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_old", "msg_old", "ses_old", 1, JSON.stringify({ type: "text", text: "old indexed text" }))

      rebuildKeywordIndexForDbPath(dbPath)
      expect(searchSessionMessages("old", { dbPath, directory: oldDir, limit: 10 }).map((item) => item.id)).toEqual(["prt_old"])

      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_current", "Current", currentDir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_current", "ses_current", JSON.stringify({ role: "user" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_current", "msg_current", "ses_current", 2, JSON.stringify({ type: "text", text: "current source text" }))

      expect(recentSessionMessages({ dbPath, directory: currentDir, limit: 10 })).toEqual([])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hybrid search helpers", () => {
  test("hybridBlend returns vector-only rows when keyword rows are empty", () => {
    const vector: Array<Record<string, unknown>> = [
      { id: "prt_v1", message_id: "msg_1", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", time_created: 1, text: "vector-only result" },
    ]
    const result = hybridBlend([], vector as never, 0.45)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("prt_v1")
    expect(result[0]?.vectorScore).toBeGreaterThan(0)
  })

  test("hybridBlend blends keyword and vector rows without duplicates", () => {
    const keyword: Array<Record<string, unknown>> = [
      { id: "prt_k1", message_id: "msg_1", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", time_created: 1, text: "keyword match alpha" },
      { id: "prt_k2", message_id: "msg_2", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", time_created: 2, text: "keyword match beta" },
    ]
    const vector: Array<Record<string, unknown>> = [
      { id: "prt_k1", message_id: "msg_1", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", time_created: 1, text: "keyword match alpha" },
      { id: "prt_v1", message_id: "msg_3", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", time_created: 3, text: "vector-only result" },
    ]
    const result = hybridBlend(keyword as never, vector as never, 0.45)
    const ids = result.map((r) => r.id)
    expect(ids).toContain("prt_k1")
    expect(ids).toContain("prt_k2")
    expect(ids).toContain("prt_v1")
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("rowToVectorResult creates a valid SearchResult with matchStart = -1", () => {
    const row = { id: "prt_v1", message_id: "msg_1", session_id: "ses_1", session_title: "Test", directory: "/tmp", role: "assistant", part_type: "text", tool: null, time_created: 1, text: "vector semantic match content" }
    const result = rowToVectorResult(row as never)
    expect(result).toBeDefined()
    expect(result!.id).toBe("prt_v1")
    expect(result!.matchStart).toBe(-1)
    expect(result!.previewHighlight).toBe(false)
    expect(result!.text).toBe("vector semantic match content")
  })

  test("hybridBlend handles empty inputs gracefully", () => {
    expect(hybridBlend([], [], 0.45)).toEqual([])
    expect(hybridBlend([], [{ id: "prt_v1", message_id: "msg_1", session_id: "ses_1", session_title: "T", directory: "/d", role: "assistant", time_created: 1, text: "x" } as never], 0.45)).toHaveLength(1)
  })
})

describe("parseSemanticConfig", () => {
  test("uses defaults when env vars are missing", () => {
    const config = parseSemanticConfig({})
    expect(config.embedBaseUrl).toBe("http://127.0.0.1:8081")
    expect(config.disableVector).toBe(true)
    expect(config.hybridAlpha).toBe(0.45)
  })

  test("parses env overrides correctly", () => {
    const config = parseSemanticConfig({
      OPENCODE_TELESCOPE_EMBED_BASE_URL: "http://localhost:9090",
      OPENCODE_TELESCOPE_ENABLE_VECTOR: "1",
      OPENCODE_TELESCOPE_HYBRID_ALPHA: "0.7",
      OPENCODE_TELESCOPE_EMBED_MODEL: "custom-model",
    })
    expect(config.embedBaseUrl).toBe("http://localhost:9090")
    expect(config.disableVector).toBe(false)
    expect(config.hybridAlpha).toBe(0.7)
    expect(config.embedModel).toBe("custom-model")
  })

  test("disable vector override wins over enable vector", () => {
    expect(parseSemanticConfig({ OPENCODE_TELESCOPE_ENABLE_VECTOR: "1", OPENCODE_TELESCOPE_DISABLE_VECTOR: "1" }).disableVector).toBe(true)
  })

  test("clamps hybridAlpha to [0, 1]", () => {
    expect(parseSemanticConfig({ OPENCODE_TELESCOPE_HYBRID_ALPHA: "-1" }).hybridAlpha).toBe(0)
    expect(parseSemanticConfig({ OPENCODE_TELESCOPE_HYBRID_ALPHA: "2" }).hybridAlpha).toBe(1)
    expect(parseSemanticConfig({ OPENCODE_TELESCOPE_HYBRID_ALPHA: "invalid" }).hybridAlpha).toBe(0.45)
  })
})

describe("ftsQuery", () => {
  test("builds FTS5 query with AND and prefix wildcards", () => {
    expect(ftsQuery("hello world")).toBe(`"hello"* AND "world"*`)
  })

  test("sanitizes special FTS5 characters", () => {
    expect(ftsQuery(`test"quote`)).toBe(`"test quote"*`)
    expect(ftsQuery(`star*s:fun`)).toBe(`"star s fun"*`)
    expect(ftsQuery("with (parens)")).toBe(`"with"* AND "parens"*`)
  })

  test("returns empty for blank query", () => {
    expect(ftsQuery("")).toBe("")
    expect(ftsQuery("   ")).toBe("")
  })
})

describe("resolveDatabasePath", () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  test("uses OPENCODE_DB absolute path directly", () => {
    process.env = { ...originalEnv, OPENCODE_DB: "/custom/path/opencode.db" }
    expect(resolveDatabasePath()).toBe("/custom/path/opencode.db")
  })

  test("returns cached path on second call", () => {
    process.env = { ...originalEnv, OPENCODE_DB: "/cached/test.db" }
    const first = resolveDatabasePath()
    const second = resolveDatabasePath()
    expect(first).toBe(second)
  })
})

describe("performSearch", () => {
  test("returns empty for blank query", async () => {
    const results = await performSearch("", { limit: 10 })
    expect(results).toEqual([])
  })

  test("returns keyword results when vector search is unavailable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-perform-keyword-"))
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
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "keywordFallbackNeedle" }))

      rebuildKeywordIndexForDbPath(dbPath)
      const response = await performSearchWithStatus("keywordFallbackNeedle", { dbPath, directory: dir, limit: 10 })
      expect(response.results.map((item) => item.id)).toEqual(["prt_1"])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns keyword results when semantic query embedding times out", async () => {
    const originalFetch = globalThis.fetch
    const originalEnv = process.env
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-perform-timeout-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      process.env = { ...originalEnv, OPENCODE_TELESCOPE_ENABLE_VECTOR: "1" }
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Test", dir)
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run("msg_1", "ses_1", JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "semanticTimeoutNeedle" }))

      rebuildKeywordIndexForDbPath(dbPath)
      const index = openSearchIndex(dbPath)
      index.exec("CREATE TABLE IF NOT EXISTS document_vec(rowid INTEGER PRIMARY KEY, embedding BLOB)")
      setMeta(index, "vector_state", "enabled")
      setMeta(index, "embedding_dimensions", "3")
      globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch

      const response = await performSearchWithStatus("semanticTimeoutNeedle", { dbPath, directory: dir, limit: 10 })
      expect(response.results.map((item) => item.id)).toEqual(["prt_1"])
    } finally {
      globalThis.fetch = originalFetch
      process.env = originalEnv
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hybrid search edge cases", () => {
  test("hybridBlend normalizes scores correctly", () => {
    const keyword = [
      { id: "k1", message_id: "m1", session_id: "s1", session_title: "T", directory: "/d", role: "assistant", part_type: "text", time_created: 1, text: "a" },
      { id: "k2", message_id: "m2", session_id: "s1", session_title: "T", directory: "/d", role: "assistant", part_type: "text", time_created: 2, text: "b" },
    ]
    const vector: never[] = []
    const result = hybridBlend(keyword as never, vector, 0.45)
    expect(result).toHaveLength(2)
    expect(result[0]!.keywordScore).toBeGreaterThanOrEqual(result[1]!.keywordScore)
    expect(result[0]!.score).toBeGreaterThan(0)
    expect(result[1]!.score).toBeGreaterThanOrEqual(0)
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
    isVectorMatch: false,
    semanticScore: 0,
  }
}
