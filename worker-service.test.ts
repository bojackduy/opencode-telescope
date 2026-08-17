import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { rebuildKeywordIndexForDbPath, searchIndexPath } from "./search.ts"
import { disposeWorkerService, previewInWorker, searchInWorker } from "./worker-service.ts"

afterEach(() => disposeWorkerService())

describe("persistent worker service", () => {
  test("searches and loads previews without direct TUI database work", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-workers-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Worker Test", dir)
      db.query("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
        .run("msg_1", "ses_1", 1, JSON.stringify({ role: "assistant" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", 1, JSON.stringify({ type: "text", text: "persistentWorkerNeedle" }))
      rebuildKeywordIndexForDbPath(dbPath)

      const response = await searchInWorker({ query: "persistentWorkerNeedle", limit: 10, dbPath, directory: dir })
      expect(response.results.map((item) => item.id)).toEqual(["prt_1"])

      const page = await previewInWorker({ operation: "around", result: response.results[0]!, before: 1, after: 1, dbPath })
      expect(page.parts.map((part) => part.id)).toEqual(["prt_1"])
    } finally {
      disposeWorkerService()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves typed search from streaming when no sidecar exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-stream-only-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    try {
      const now = Date.now()
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);
      `)
      db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Stream Only", dir)
      db.query("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
        .run("msg_1", "ses_1", now, JSON.stringify({ role: "user" }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)")
        .run("prt_1", "msg_1", "ses_1", now, JSON.stringify({ type: "text", text: "streamOnlyNeedle" }))

      const batches: string[][] = []
      const response = await searchInWorker(
        { query: "streamOnlyNeedle", limit: 10, dbPath, directory: dir },
        { onStreamBatch: (results) => batches.push(results.map((item) => item.id)) },
      )

      expect(batches.some((ids) => ids.includes("prt_1"))).toBe(true)
      expect(response.results.map((item) => item.id)).toEqual(["prt_1"])
    } finally {
      disposeWorkerService()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolves when streaming completes before the unavailable-index response", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-stream-race-"))
    const dbPath = path.join(dir, "opencode.db")
    const db = new Database(dbPath)
    let indexLock: Database | undefined
    let releaseLock: ReturnType<typeof setTimeout> | undefined
    let locked = false
    try {
      db.exec(`
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER NOT NULL, data TEXT);
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);
      `)

      indexLock = new Database(searchIndexPath(dbPath))
      indexLock.exec("PRAGMA journal_mode = WAL; CREATE TABLE blocker(id INTEGER); BEGIN IMMEDIATE")
      locked = true
      releaseLock = setTimeout(() => {
        indexLock?.exec("COMMIT")
        locked = false
      }, 300)

      const batches: string[] = []
      const response = await searchInWorker(
        { query: "streamRaceNeedle", limit: 10, dbPath, directory: dir },
        { onStreamBatch: (_results, bucket) => batches.push(bucket) },
      )

      expect(batches).toEqual(["no-sessions"])
      expect(response.keywordState).toBe("empty")
      expect(response.results).toEqual([])
    } finally {
      if (releaseLock) clearTimeout(releaseLock)
      if (locked) indexLock?.exec("COMMIT")
      disposeWorkerService()
      indexLock?.close()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
