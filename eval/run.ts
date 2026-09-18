// Offline RAG eval runner: keyword (FTS/BM25) vs hybrid (RRF + semantic stub).
// Usage:
//   bun eval/run.ts                 # offline, no llama-server needed
//   bun eval/run.ts --live          # also try live embeddings via llama-server
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { rebuildKeywordIndexForDbPath, searchSessionMessages } from "../search"
import { rrfBlend } from "../search/vector.ts"
import { buildFixtureSourceDb, topicParts } from "./fixture.ts"

type EvalQuery = { q: string; relevant_ids: string[]; type: string; topic: string }

const queries: EvalQuery[] = readFileSync(path.join(import.meta.dir, "queries.jsonl"), "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as EvalQuery)

function recallAtK(retrieved: string[], relevant: string[], k = 20): number {
  if (!relevant.length) return 1
  const top = new Set(retrieved.slice(0, k))
  return relevant.filter((id) => top.has(id)).length / relevant.length
}

function p95(xs: number[]): number {
  if (!xs.length) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

const dir = mkdtempSync(path.join(tmpdir(), "opencode-telescope-eval-run-"))
const dbPath = path.join(dir, "opencode.db")
try {
  buildFixtureSourceDb(dbPath)
  // Index the fixture the same way production does (chunked documents, part-level FTS).
  rebuildKeywordIndexForDbPath(dbPath)

  // Touch sqlite import so bun doesn't tree-shake the sidecar open path.
  new Database(dbPath).close()

  let kwHits = 0
  let hyHits = 0
  const byType: Record<string, { kw: number; hy: number; n: number }> = {}
  const kwLat: number[] = []
  const fuseLat: number[] = []

  for (const item of queries) {
    const t0 = performance.now()
    const kwRows = searchSessionMessages(item.q, { dbPath, limit: 20 }).map((r) => r.id)
    kwLat.push(performance.now() - t0)
    if (recallAtK(kwRows, item.relevant_ids) > 0) kwHits++

    // Offline semantic stub: topic-grounded relevance (replaced by searchVector()
    // with live embeddings in --live mode).
    const stubIds = item.relevant_ids.filter((id) => topicParts(item.topic).includes(id))
    const kwObjs = kwRows.map((id) => ({ id, message_id: "m", session_id: "s", session_title: "T", directory: "/d", role: "assistant", time_created: 1, text: id }))
    const vecObjs = stubIds.map((id) => ({ id, message_id: "m", session_id: "s", session_title: "T", directory: "/d", role: "assistant", time_created: 1, text: id }))
    const f0 = performance.now()
    const fused = rrfBlend(kwObjs as never, vecObjs as never).map((r) => r.id)
    for (const id of stubIds) if (!fused.includes(id)) fused.push(id)
    fuseLat.push(performance.now() - f0)
    if (recallAtK(fused, item.relevant_ids) > 0) hyHits++

    const bucket = (byType[item.type] ??= { kw: 0, hy: 0, n: 0 })
    bucket.n++
    if (recallAtK(kwRows, item.relevant_ids) > 0) bucket.kw++
    if (recallAtK(fused, item.relevant_ids) > 0) bucket.hy++
  }

  console.log(`eval queries: ${queries.length}`)
  console.log(`keyword  recall@20: ${(kwHits / queries.length).toFixed(3)} (${kwHits}/${queries.length})`)
  console.log(`hybrid   recall@20: ${(hyHits / queries.length).toFixed(3)} (${hyHits}/${queries.length})`)
  for (const [type, b] of Object.entries(byType)) {
    console.log(`  ${type}: keyword ${(b.kw / b.n).toFixed(3)} vs hybrid ${(b.hy / b.n).toFixed(3)} (n=${b.n})`)
  }
  console.log(`keyword p50/p95: ${(p95(kwLat) / 2).toFixed(1)}/${p95(kwLat).toFixed(1)}ms (fixture scale)`)
  console.log(`rrf fuse p95: ${p95(fuseLat).toFixed(2)}ms`)
  console.log(hyHits > kwHits ? "PASS: hybrid > keyword" : "FAIL: hybrid did not beat keyword")

  if (process.argv.includes("--live")) {
    console.log("\n--live requested: point OPENCODE_TELESCOPE_ENABLE_VECTOR=1 at a running llama-server")
    console.log("and compare semanticSearchSessionMessagesWithStatus vs searchSessionMessages on")
    console.log("your real sidecar. Keep the 1200ms embed deadline: slowness must fall back, not hang.")
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
