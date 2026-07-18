# Search Architecture Refactor Task Tracker

This file tracks implementation tasks for the search architecture refactor described in `docs/search-architecture-refactor-plan.md`.

Status legend:

| Status | Meaning |
| --- | --- |
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Complete |
| `[!]` | Blocked |

## Phase 1: Sidecar-Only Search Path

Goal: user-facing search reads only ready or stale sidecar indexes. It must not rebuild indexes or broadly scan the OpenCode source DB.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P1.1 | [ ] | Add `KeywordIndexState` type | `search/types.ts` | none | Type supports `ready`, `stale`, `missing`, `empty`, `indexing`, `error` |
| P1.2 | [ ] | Add `SearchResponse` type with results and index states | `search/types.ts` | P1.1 | Search response carries `results`, `keywordState`, `vectorState`, `stale` |
| P1.3 | [ ] | Split `ensureSearchIndex` into open, state-read, and rebuild responsibilities | `search/queries.ts` | P1.1 | Opening sidecar no longer rebuilds synchronously |
| P1.4 | [ ] | Add `openSearchIndex(sourcePath)` helper | `search/queries.ts` | P1.3 | Helper opens and migrates sidecar only |
| P1.5 | [ ] | Add `readKeywordIndexState(source, index, sourcePath)` helper | `search/queries.ts` | P1.3 | Helper reports state without rebuilding |
| P1.6 | [ ] | Rename or extract current `rebuildSearchIndex` into `rebuildKeywordIndex` | `search/queries.ts` | P1.3 | Rebuild function is callable by index worker only |
| P1.7 | [ ] | Make `recentSessionMessages` sidecar-only by default | `search/queries.ts` | P1.4, P1.5 | Missing/empty index returns `[]` immediately |
| P1.8 | [ ] | Return stale recent rows immediately when available | `search/queries.ts` | P1.7 | Stale sidecar rows render while rebuild is requested |
| P1.9 | [ ] | Remove default `sourceRecentRows` call from recent/open path | `search/queries.ts` | P1.7 | Initial open never calls `visibleTextRows` by default |
| P1.10 | [ ] | Make typed keyword search sidecar-only by default | `search/queries.ts` | P1.4, P1.5 | Typed search does not trigger `rebuildKeywordIndex` |
| P1.11 | [ ] | Add status-returning recent API | `search/queries.ts` | P1.2, P1.7 | `recentSessionMessagesWithStatus` returns `SearchResponse` |
| P1.12 | [ ] | Add status-returning search API | `search/queries.ts` | P1.2, P1.10 | `searchSessionMessagesWithStatus` returns `SearchResponse` |
| P1.13 | [ ] | Preserve old API wrappers | `search/queries.ts`, `search.ts` | P1.11, P1.12 | Existing callers can still get `SearchResult[]` |

## Phase 2: Dedicated Index Worker

Goal: all keyword sidecar writes happen in a separate worker that is never the UI search worker.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P2.1 | [ ] | Create `index-worker.ts` | `index-worker.ts` | P1.6 | Worker file exists and compiles |
| P2.2 | [ ] | Define index worker request/response message types | `index-worker.ts`, optionally `search/types.ts` | P2.1 | Messages cover start, done, error |
| P2.3 | [ ] | Implement keyword rebuild request handler | `index-worker.ts`, `search/queries.ts` | P1.6, P2.2 | Worker calls `rebuildKeywordIndex` |
| P2.4 | [ ] | Set keyword indexing metadata before/after rebuild | `index-worker.ts`, `search/schema.ts` | P2.3 | Sidecar records indexing state and errors |
| P2.5 | [ ] | Add WAL and busy timeout pragmas for sidecar DB | `search/schema.ts` or sidecar open helper | P1.4 | Search can read while index worker writes when possible |
| P2.6 | [ ] | Add `index-worker.ts` to npm package files | `package.json` | P2.1 | `npm pack --dry-run` includes `index-worker.ts` |
| P2.7 | [ ] | Keep `search-worker.ts` in package files | `package.json` | none | `npm pack --dry-run` includes `search-worker.ts` |

## Phase 3: UI Worker Orchestration

Goal: UI coordinates fast search reads and background indexing without blocking or showing misleading errors.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P3.1 | [ ] | Update search worker to return `SearchResponse` metadata | `search-worker.ts` | P1.11, P1.12 | Worker returns keyword/vector state fields |
| P3.2 | [ ] | Add index worker lifecycle in UI | `telescope.tsx` | P2.1, P3.1 | UI can create and terminate index worker |
| P3.3 | [ ] | Add one-index-job-per-dbPath guard | `telescope.tsx` | P3.2 | Repeated stale responses do not spawn duplicate jobs |
| P3.4 | [ ] | Start index worker for `missing`, `empty`, `stale`, or `error` states | `telescope.tsx` | P3.1, P3.2 | UI starts background rebuild based on response state |
| P3.5 | [ ] | Refresh current search after index worker completes | `telescope.tsx` | P3.4 | Current query/recent results refresh once after rebuild |
| P3.6 | [ ] | Change worker timeout from red error to non-blocking status | `telescope.tsx` | P3.1 | Timeout clears loading and does not source-scan on UI thread |
| P3.7 | [ ] | Remove unsafe main-thread search fallback or make it sidecar-only | `telescope.tsx` | P1.13 | Worker failure cannot trigger broad source DB scan |
| P3.8 | [ ] | Add index status signal | `telescope.tsx` | P3.1 | UI can render indexing/updating state |
| P3.9 | [ ] | Update empty state copy for indexing | `components/result-list.tsx` | P3.8 | First-run missing index shows friendly non-error message |

## Phase 4: Semantic Search As Best-Effort Enhancement

Goal: semantic/vector search never blocks keyword results and never performs document embedding during a search request.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P4.1 | [ ] | Add `isVectorReady(index)` helper | `search/vector.ts` | P1.4 | Helper checks state, dimensions, and table readiness |
| P4.2 | [ ] | Remove vector rebuild scheduling from `performSearch` path | `search/queries.ts` | P4.1 | `performSearch` never calls `setupVectorTable` |
| P4.3 | [ ] | Return keyword results immediately when vector is not ready | `search/queries.ts` | P4.2 | Vector unavailable does not delay search |
| P4.4 | [ ] | Add short query embedding deadline | `search/embedding.ts`, `search/queries.ts` | P4.3 | Slow query embedding falls back to keyword |
| P4.5 | [ ] | Keep document embedding rebuild background-only | `search/vector.ts`, `index-worker.ts` | P2.3 | Document embedding is never done by search worker |
| P4.6 | [ ] | Update vector status in `SearchResponse` | `search/queries.ts`, `search/types.ts` | P4.1 | UI can show semantic ready/unavailable status |

## Phase 5: Tests And Verification

Goal: lock the architecture down with regression tests and package checks.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P5.1 | [ ] | Test recent missing sidecar returns immediately | `search.test.ts` | P1.7 | No source fallback expected |
| P5.2 | [ ] | Test recent stale sidecar returns stale rows | `search.test.ts` | P1.8 | Stale rows still appear |
| P5.3 | [ ] | Test typed search missing FTS returns immediately | `search.test.ts` | P1.10 | No synchronous rebuild expected |
| P5.4 | [ ] | Test typed search stale FTS returns stale rows | `search.test.ts` | P1.10 | Query uses stale sidecar |
| P5.5 | [ ] | Test `performSearch` returns keyword when vector unavailable | `search.test.ts` | P4.3 | Keyword result is not blocked by vector |
| P5.6 | [ ] | Test semantic timeout returns keyword | `search.test.ts` | P4.4 | Slow embedding does not fail search |
| P5.7 | [ ] | Test index worker rebuild helper | `index-worker.test.ts` or helper tests | P2.3 | Keyword sidecar is rebuilt correctly |
| P5.8 | [ ] | Test package dry-run includes workers | package verification script or manual check | P2.6, P2.7 | `npm pack --dry-run` shows both workers |
| P5.9 | [ ] | Run typecheck | all | implementation complete | `bun run typecheck` passes |
| P5.10 | [ ] | Run full tests | all | implementation complete | `bun test` passes |
| P5.11 | [ ] | Run package dry-run | package | implementation complete | `npm pack --dry-run` passes |

## Phase 6: Documentation And Release

Goal: document user-visible behavior and ship safely.

| ID | Status | Task | Files | Depends On | Acceptance Check |
| --- | --- | --- | --- | --- | --- |
| P6.1 | [ ] | Document first-run keyword indexing behavior | `docs/semantic-search.md`, `README.md` if needed | P3.9 | Docs explain background indexing |
| P6.2 | [ ] | Document semantic search remains optional | `docs/semantic-search.md` | P4.6 | Docs clarify `llama-server` is optional |
| P6.3 | [ ] | Document troubleshooting for stale OpenCode package cache | `docs/semantic-search.md` or README | package release | Users can clear `~/.cache/opencode/packages/@bojackduy` |
| P6.4 | [ ] | Publish patch release | npm | P5.9, P5.10, P5.11 | New version appears under npm `latest` |
| P6.5 | [ ] | Verify published tarball | npm | P6.4 | Published package includes workers and search files |

## Critical Path

Follow this order for the safest implementation:

| Order | Task IDs | Outcome |
| --- | --- | --- |
| 1 | P1.1-P1.6 | Search/index responsibilities are separated |
| 2 | P1.7-P1.13 | Search path is sidecar-only and non-rebuilding |
| 3 | P2.1-P2.7 | Background indexing has its own worker |
| 4 | P3.1-P3.9 | UI handles indexing states without freezing |
| 5 | P4.1-P4.6 | Semantic is best-effort only |
| 6 | P5.1-P5.11 | Regression coverage and package verification |
| 7 | P6.1-P6.5 | Docs and release |

## High-Risk Areas

| Area | Risk | Mitigation |
| --- | --- | --- |
| SQLite read/write contention | Search worker reads while index worker writes | Use WAL, busy timeout, and catch lock errors |
| UI refresh loops | Index completion triggers repeated searches | Add one refresh per completed index job |
| Duplicate indexing jobs | Multiple stale responses spawn workers | Use `activeIndexJobs` keyed by `dbPath` |
| Semantic regressions | Vector path blocks keyword search again | Tests assert keyword fallback on vector timeout |
| Package misses worker files | Published plugin breaks on other machines | `npm pack --dry-run` must be checked before publish |

## Completion Checklist

- [ ] Search request path never calls `rebuildKeywordIndex`.
- [ ] Search request path never calls document embedding rebuild.
- [ ] Recent open never calls broad source DB fallback by default.
- [ ] Missing index returns quickly with status.
- [ ] Stale index returns stale rows quickly.
- [ ] Index worker rebuilds keyword sidecar in background.
- [ ] UI starts index worker based on search response state.
- [ ] Worker timeout clears loading and does not source-scan on UI thread.
- [ ] Semantic query returns keyword results if vector is unavailable or slow.
- [ ] `bun run typecheck` passes.
- [ ] `bun test` passes.
- [ ] `npm pack --dry-run` includes `search-worker.ts` and `index-worker.ts`.
