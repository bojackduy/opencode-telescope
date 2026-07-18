# Search Architecture Refactor Plan

## Goal

Make Telescope search safe on weaker machines by ensuring user-facing search requests never perform slow indexing, embedding, or broad OpenCode source DB scans.

Target behavior:

- Recent/search requests return quickly from ready or stale Telescope sidecar indexes.
- Missing or empty indexes return immediately with an indexing status.
- Keyword index rebuilds run in a dedicated background index worker.
- Semantic/vector search is best-effort and only runs when vectors are already ready.
- Source DB scan fallback is disabled by default.
- Worker timeout clears loading without running heavy work on the UI thread.

## Current Internal Paths

1. Source DB scan

   Direct OpenCode DB query over `session`, `message`, and `part` with `json_extract`, joins, and sorting. This is slow on large histories and should not run by default in UI search.

2. Keyword sidecar index

   Telescope-owned sidecar tables: `document`, `document_fts`, and `document_index`. This is normal fast text search and does not require embeddings.

3. Semantic vector index

   Optional `document_vec` table backed by `sqlite-vec` and `llama-server` embeddings. This should enhance keyword results only when already ready.

## File Breakdown

### `search/types.ts`

Tasks:

- Add `KeywordIndexState`:

```ts
export type KeywordIndexState = "ready" | "stale" | "missing" | "empty" | "indexing" | "error"
```

- Add a search response type:

```ts
export type SearchResponse = {
  results: SearchResult[]
  keywordState: KeywordIndexState
  vectorState?: VectorState
  stale: boolean
}
```

- Keep `SearchResult` unchanged so UI/result row rendering remains stable.

### `search/schema.ts`

Tasks:

- Add sidecar DB pragmas in migration/open path where appropriate:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 1000;
```

- Keep table schemas stable unless a change is required.
- Add metadata keys if needed:

```txt
keyword_state
keyword_indexing_started_at
keyword_indexed_at
keyword_index_error
```

### `search/queries.ts`

Tasks:

- Split current `ensureSearchIndex` responsibilities.

New functions:

```ts
openSearchIndex(sourcePath: string): Database
readKeywordIndexState(source: Database, index: Database, sourcePath: string): KeywordIndexState
rebuildKeywordIndex(source: Database, index: Database, sourcePath: string, state: SourceState): void
```

- `openSearchIndex` should only open/migrate sidecar. It must not rebuild.
- `readKeywordIndexState` should only compare metadata and row availability.
- `rebuildKeywordIndex` should contain current `rebuildSearchIndex` logic and be used only by `index-worker.ts`.
- Update `recentSessionMessages` to become sidecar-only by default:

```txt
if sidecar has rows:
  return rows even if stale
if sidecar missing/empty:
  return [] immediately
```

- Remove default call to `sourceRecentRows()` from recent/open path.
- Update `searchSessionMessages` / `indexedTextRows` to never rebuild synchronously.
- If FTS is missing, return `[]` and report `missing` or `empty`.
- If FTS is stale but queryable, return stale rows and report `stale`.
- Keep `visibleTextRows` only as an explicit opt-in fallback:

```txt
OPENCODE_TELESCOPE_ALLOW_SOURCE_FALLBACK=1
```

- Add response-producing APIs for workers:

```ts
searchSessionMessagesWithStatus(...): SearchResponse
recentSessionMessagesWithStatus(...): SearchResponse
performSearchWithStatus(...): Promise<SearchResponse>
```

- Preserve existing APIs as wrappers returning only `.results` where tests or UI still need them.

### `search/vector.ts`

Tasks:

- Ensure document embedding rebuild remains background-only.
- `performSearchWithStatus` must not call `setupVectorTable`.
- Keep `searchVector` query-only.
- Add a safe vector readiness check:

```ts
isVectorReady(index: Database): boolean
```

- Vector search should run only when:

```txt
vector_state == enabled
document_vec exists
embedding_dimensions exists
```

### `search/embedding.ts`

Tasks:

- Keep health timeout short.
- Keep query embedding timeout short.
- Consider lowering query embedding timeout from `15_000` to `1_500` ms for UI search enhancement.
- Document embedding batch calls remain index-worker/background only.

### `search-worker.ts`

Tasks:

- Make this worker read-only and fast.
- Use `performSearchWithStatus` and `recentSessionMessagesWithStatus`.
- Return status metadata:

```ts
self.postMessage({
  type: "search-result",
  id,
  result: response.results,
  keywordState: response.keywordState,
  vectorState: response.vectorState,
  stale: response.stale,
  limit,
})
```

- Do not rebuild indexes.
- Do not call broad source DB fallback by default.
- If sidecar is locked, return `keywordState: "indexing"` and `results: []`.

### `index-worker.ts`

Tasks:

- New worker dedicated to sidecar writes.
- Message contract:

```ts
type IndexWorkerRequest = {
  type: "rebuild-keyword-index"
  id: number
  dbPath: string
}
```

- Worker flow:

```txt
open source DB readonly
open sidecar DB read/write
set keyword_state=indexing
run rebuildKeywordIndex
set keyword_state=ready or error
post done/error
optionally schedule vector rebuild if vector enabled
```

- Do not block UI search worker.
- Ensure only one rebuild per `dbPath` runs in the UI orchestration layer.

### `telescope.tsx`

Tasks:

- Keep search worker for quick reads.
- Add index worker lifecycle and one-job-per-dbPath guard:

```ts
let indexWorker: Worker | undefined
const activeIndexJobs = new Set<string>()
```

- Start index worker when search response reports:

```txt
missing
empty
stale
error
```

- On index worker completion, refresh current query once.
- Change timeout behavior:

```txt
clear loading
keep existing results if available
show non-error status instead of red failure for initial/recent timeout
do not run main-thread fallback that can source-scan
```

- Add status labels:

```txt
Indexing conversations...
Updating index...
Keyword index ready
Semantic ready
Semantic unavailable
```

- Ensure initial empty state can distinguish:

```txt
no results
index missing/empty/indexing
search error
```

### `components/result-list.tsx`

Tasks:

- If needed, extend `EmptyState` props to accept index/search status.
- Render user-friendly copy for indexing states:

```txt
Indexing conversations in background...
Try your search again shortly.
```

- Avoid red error styling for expected first-run indexing.

### `package.json`

Tasks:

- Ensure package files include both workers:

```json
"search-worker.ts",
"index-worker.ts"
```

- Keep `search` directory included.
- Verify with:

```bash
npm pack --dry-run
```

### `search.test.ts`

Tasks:

- Update tests that assume search calls rebuild synchronously.
- Add tests:

```txt
recent returns [] immediately when sidecar missing
recent returns stale sidecar rows without source fallback
typed search returns [] immediately when FTS missing
typed search queries stale FTS without rebuilding
performSearch returns keyword rows when vector unavailable
performSearch returns keyword rows when vector query times out
```

### Worker Tests

Possible files:

```txt
search-worker.test.ts
index-worker.test.ts
```

Tasks:

- Test worker message contracts where practical.
- At minimum, test exported query/index helpers directly if worker testing is cumbersome under Bun.

### `docs/semantic-search.md`

Tasks:

- Clarify default behavior:

```txt
Keyword search works without llama-server.
Semantic search is optional enhancement.
First run may build a keyword index in the background.
```

- Add troubleshooting for indexing status.

## Implementation Phases

### Phase 1: Make Keyword Index Read-Only In Search Path

Files:

```txt
search/types.ts
search/queries.ts
search.test.ts
```

Tasks:

- Add `KeywordIndexState` and `SearchResponse`.
- Split sidecar open/state/rebuild logic.
- Make recent and typed search sidecar-only by default.
- Remove default source scan fallback.
- Preserve old wrapper APIs.

Verification:

```bash
bun run typecheck
bun test search.test.ts
```

### Phase 2: Add Dedicated Index Worker

Files:

```txt
index-worker.ts
search/queries.ts
package.json
```

Tasks:

- Move rebuild entrypoint into exported helper.
- Add index worker and message contract.
- Include worker in npm package files.

Verification:

```bash
bun run typecheck
bun test
npm pack --dry-run
```

### Phase 3: Wire UI Orchestration

Files:

```txt
telescope.tsx
components/result-list.tsx
```

Tasks:

- Start index worker based on search response state.
- Add index job guard.
- Refresh current search after indexing completes.
- Convert timeout into non-blocking status.
- Remove unsafe main-thread fallback behavior.

Verification:

```bash
bun run typecheck
bun test
```

### Phase 4: Make Semantic Strictly Best-Effort

Files:

```txt
search/queries.ts
search/vector.ts
search/embedding.ts
```

Tasks:

- Run vector query only if vector index is already ready.
- Never schedule vector rebuild from `performSearch`.
- Lower query embedding timeout.
- Return keyword results on any semantic issue.

Verification:

```bash
bun run typecheck
bun test
```

### Phase 5: Documentation And Release Safety

Files:

```txt
docs/semantic-search.md
docs/search-architecture-refactor-plan.md
package.json
```

Tasks:

- Document first-run indexing behavior.
- Document semantic opt-in/runtime dependency expectations.
- Verify package contents.

Verification:

```bash
npm pack --dry-run
```

## Definition Of Done

- Opening Telescope on a large DB does not show an indefinite skeleton.
- Worker timeout does not trigger broad source DB scans on the UI thread.
- First-run missing index returns immediately with an indexing status.
- Stale keyword sidecar rows are usable while background indexing runs.
- Typed search does not rebuild keyword index synchronously.
- Semantic search never blocks keyword results.
- `OPENCODE_TELESCOPE_DISABLE_VECTOR=1` disables only vector behavior, but the app remains fast either way.
- `npm pack --dry-run` includes all worker and search files.
