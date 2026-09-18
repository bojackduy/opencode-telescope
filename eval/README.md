# RAG Eval

Offline harness proving hybrid (RRF + semantic) beats keyword (FTS/BM25) on
recall@20 without hurting latency — and locking the chunking/ranking fixes
with regression tests.

## Run

```bash
bun test eval/rag-eval.test.ts   # unit + 100-query eval (no server needed)
bun eval/run.ts                  # printable report
bun eval/run.ts --live           # notes for live-embedding comparison
```

## What it measures

* Corpus: `eval/fixture.ts` — 27 parts across topics (auth, deploy, fts,
  vector, patch, bug, ...), indexed through the real `rebuildKeywordIndex`
  path (chunked `document`, part-level FTS).
* Queries: `eval/queries.jsonl` — 100 queries with relevance judgments:
  30 exact (symbol/error strings), 50 paraphrase (reworded, keyword misses),
  20 vague (cross-session recall).
* Metrics: recall@20 overall + per-type, keyword p95, RRF fuse p95.

Expected (fixture scale): keyword ~0.47 overall (~0.93 exact, ~0.34
paraphrase), hybrid 1.00 with the topic stub, fuse p95 <1ms.

## Honest caveat

The offline "vector" is a topic-grounded stub standing in for
`llama-server` embeddings, so hybrid-vs-keyword here validates the **fusion,
chunking, and lifecycle plumbing** — not live embedding quality. Before
enabling vector by default, run the live comparison on your real sidecar:

1. `OPENCODE_TELESCOPE_ENABLE_VECTOR=1` with `llama-server` healthy.
2. Compare `semanticSearchSessionMessagesWithStatus` vs
   `searchSessionMessages` on your own 100 real history queries.
3. Ship criteria: hybrid recall@20 ≥ keyword +5pts on paraphrase, no exact
   regression, keyword p95 interactive, slow embeddings fall back (1200ms
   deadline) instead of hanging.

## What the harness locks in

* `chunkTextForEmbedding`: fence-aware, bounded, overlapping, deterministic.
* Stable `doc_id = telescope:{session}:{message}:{part}:{chunk}` + content
  hashes (not ID hashes).
* `vec_map(doc_id)` join instead of unstable `rowid` join.
* Incremental versioned re-embed (`embedding_version` = model + prefixes +
  chunker v2); only changed/removed chunks invalidate vectors.
* RRF (k=60, alpha-weighted) instead of rank-linear + min-max blend.
