import { Database } from "bun:sqlite"

// Fixture corpus mimicking real conversation history: exact symbols for
// keyword hits + distinct paraphrase wording for semantic-only hits.
export type FixturePart = { id: string; topic: string; role: "user" | "assistant"; type: "text"; text: string }

export const FIXTURE_PARTS: FixturePart[] = [
  { id: "prt_auth_1", topic: "auth", role: "user", type: "text", text: "How should we do token memoization for login? Need session expiry handling for validateSession." },
  { id: "prt_auth_2", topic: "auth", role: "assistant", type: "text", text: "Auth token refresh flow uses memoized credentials with expiry timestamps. See auth caching discussion." },
  { id: "prt_deploy_1", topic: "deploy", role: "user", type: "text", text: "Rollout release ship checklist for production launch. Deploy with canary first." },
  { id: "prt_deploy_2", topic: "deploy", role: "assistant", type: "text", text: "Deploy rollback strategy: keep previous artifact, rollout in stages, monitor launch metrics." },
  { id: "prt_fts_1", topic: "fts", role: "assistant", type: "text", text: "SQLite FTS5 with bm25 ranking makes keyword search fast. Full text index over conversation history." },
  { id: "prt_fts_2", topic: "fts", role: "user", type: "text", text: "FTS prefix wildcard AND query: \"hello\"* AND \"world\"* for scoped search." },
  { id: "prt_vec_1", topic: "vector", role: "assistant", type: "text", text: "Nomic embed text vector index via sqlite-vec. Long documents are chunked with overlap so embeddings represent full content." },
  { id: "prt_vec_2", topic: "vector", role: "user", type: "text", text: "Embedding dimensions model prefix: search_document vs search_query. Version mismatch triggers re-embed." },
  { id: "prt_patch_1", topic: "patch", role: "assistant", type: "text", text: "Applied validateForSubmit via apply_patch. SEARCH_WORKER_TIMEOUT_MS raised. See filediff hunk for details." },
  { id: "prt_patch_2", topic: "patch", role: "user", type: "text", text: "Edit oldString newString diff for the patch application. How did we apply the code change?" },
  { id: "prt_bug_1", topic: "bug", role: "user", type: "text", text: "Exception failure stack trace on login. Crash with an error, need defect triage." },
  { id: "prt_bug_2", topic: "bug", role: "assistant", type: "text", text: "Bug defect issue triage: reproduce with failing input, fix error handling, add regression test." },
  { id: "prt_refactor_1", topic: "refactor", role: "assistant", type: "text", text: "Restructure rewrite cleanup: reorganize messy module boundary, improve readability." },
  { id: "prt_config_1", topic: "config", role: "user", type: "text", text: "Configuration setting setup option stored in config file. Change default settings here." },
  { id: "prt_db_1", topic: "db", role: "assistant", type: "text", text: "SQL query schema storage with indexing. Data persisted locally in sqlite, database performance tuned." },
  { id: "prt_db_2", topic: "db", role: "user", type: "text", text: "Persist query results locally. How is data stored across sessions?" },
  { id: "prt_test_1", topic: "test", role: "assistant", type: "text", text: "Unit test spec assertion verify correctness. Add coverage for edge cases, quarantine flaky test." },
  { id: "prt_sec_1", topic: "security", role: "assistant", type: "text", text: "Permission access vulnerability review. Least privilege access control, keep endpoint secure." },
  { id: "prt_perf_1", topic: "perf", role: "assistant", type: "text", text: "Speed up efficient fast path. P95 latency budget per keystroke, optimize hot path for large DB." },
  { id: "prt_small_1", topic: "small", role: "user", type: "text", text: "Hello greeting, need help with setup. Thanks, appreciate the guide!" },
  { id: "prt_ux_1", topic: "ux", role: "assistant", type: "text", text: "Session jump preview anchor keeps match in view. Open result at right message, recent searches empty state." },
  { id: "prt_worker_1", topic: "worker", role: "assistant", type: "text", text: "Worker timeout fallback to indexing state. Background job keeps UI fast when search is slow." },
  { id: "prt_scope_1", topic: "scope", role: "user", type: "text", text: "Scoped search user assistant thought syntax. Only my prompts about timeout, find reasoning traces." },
  { id: "prt_chunk_1", topic: "chunk", role: "assistant", type: "text", text: "Chunk overlap split boundary for long documents. Cut on paragraph lines, don't break code fences." },
  { id: "prt_rank_1", topic: "rank", role: "assistant", type: "text", text: "Reciprocal rank fusion RRF combines keyword and vector. Hybrid alpha blend weight, recall at twenty evaluation." },
  { id: "prt_sync_1", topic: "sync", role: "assistant", type: "text", text: "Incremental sync checkpoint rowid avoids full rebuild. New messages indexed in background, version mismatch re-embeds." },
  { id: "prt_ops_1", topic: "ops", role: "assistant", type: "text", text: "Sqlite-vec extension load path on mac. Llama-server health check, why vector is unavailable." },
]

export function buildFixtureSourceDb(dbPath: string) {
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    const dir = "/repo"
    db.query("INSERT INTO session(id, title, directory) VALUES (?, ?, ?)").run("ses_1", "Fixture", dir)
    let t = 1
    for (const part of FIXTURE_PARTS) {
      const msgId = `msg_${part.id}`
      db.query("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run(msgId, "ses_1", JSON.stringify({ role: part.role }))
      db.query("INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
        part.id,
        msgId,
        "ses_1",
        t++,
        JSON.stringify({ type: part.type, text: part.text }),
      )
    }
  } finally {
    db.close()
  }
}

export function topicParts(topic: string): string[] {
  return FIXTURE_PARTS.filter((p) => p.topic === topic).map((p) => p.id)
}
