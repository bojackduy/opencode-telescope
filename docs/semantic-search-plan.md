# Semantic Search Enhancement Plan

## Goal

Upgrade opencode-telescope from keyword/fuzzy conversation search to an optional semantic finder that can retrieve relevant past messages even when the query does not share exact words with the original conversation.

Example target behavior:

- Query: `why did preview jump when loading older messages`
- Match: a past conversation that used words like `prepend`, `scroll anchoring`, `PageUp`, or `virtualization`
- Existing FTS search should still work when vector search dependencies are unavailable.

## Reference Project

This plan is informed by `opencode-smart-session-picker/`, especially:

- `src/search/sidecar.ts`: sidecar DB, FTS5, `sqlite-vec`, vector queries.
- `src/search/embedding.ts`: local `llama-server` embedding client.
- `src/search/extractor.ts`: session/message/part document extraction.
- `src/search/ranking.ts`: keyword/vector score blending.
- `docs/vector-sidecar-runtime.md`: sidecar boundary and SQLite runtime constraints.
- `plans/semantic-session-search-plan.md`: semantic picker architecture and operational principles.

The reference project searches sessions. Telescope searches specific message parts and jumps to exact conversation locations, so the design must be adapted rather than copied directly.

## Current Telescope Search

Telescope currently reads OpenCode's SQLite database in read-only mode and maintains a disposable sidecar at:

```txt
<opencode-db-name>-telescope-search.db
```

The current sidecar contains:

- `index_meta`
- `document_fts`
- `document_index`

The current public search path is:

```txt
searchSessionMessages(query)
  -> searchRows(...)
  -> indexedTextRows(...) using FTS5
  -> fallback visibleTextRows(...) using LIKE
  -> rowToSearchResult(...)
```

The existing result model is part-level:

- `id` is a part ID.
- `messageID` and `sessionID` identify navigation target context.
- `snippet`, `excerpt`, and preview fields are built around literal matches.

Semantic search must preserve that exact-result UX.

## Design Principles

- Keep OpenCode's database read-only. All semantic state is derived sidecar data.
- Keep FTS as the reliable baseline. Vector search is optional and must degrade cleanly.
- Return part-level results, not only session-level results.
- Do not require FTS hits before running semantic/vector retrieval.
- Do not auto-download embedding models.
- Keep local-only by default. Initial vector implementation should target a local embedding server.
- Make sidecar data disposable and rebuildable from OpenCode's SQLite tables.
- Version schema, extractor, ranking, embedding profile, and vector state in metadata.

## Key Lesson From Smart Session Picker

The smart picker already has the right pieces:

- sidecar-owned documents
- FTS5 keyword ranking
- `sqlite-vec` vector storage
- local `llama-server` embedding client
- hybrid score blending
- dependency/status reporting

But its hybrid query path currently has an important limitation:

```ts
const keyword = await sidecar.searchFts(query)
if (!keyword.length) return []
```

That means vector search only runs after an FTS hit. Telescope should avoid this. A semantic finder must allow vector-only matches.

Correct Telescope behavior:

```txt
keyword candidates = FTS(query)
vector candidates = vectorSearch(embed(query))
merged candidates = union(keyword, vector)
ranked candidates = blend + boosts
```

## Proposed Architecture

```txt
OpenCode SQLite DB
  source of truth: session, message, part

Telescope sidecar DB
  index_meta
  document
  document_fts
  document_index
  document_vec (optional sqlite-vec)

Embedding server
  optional local llama-server /v1/embeddings

Telescope TUI
  existing result list + preview + jump behavior
```

## Sidecar Schema Changes

Keep existing `document_fts` and `document_index`, but add a canonical `document` table for semantic document metadata.

Suggested schema:

```sql
create table if not exists document(
  rowid integer primary key,
  doc_id text unique not null,
  part_id text not null,
  message_id text not null,
  session_id text not null,
  session_title text not null,
  directory text not null,
  role text not null,
  part_type text not null,
  tool text,
  time_created integer not null,
  chunk_index integer not null,
  text text not null,
  source_hash text not null,
  extractor_version text not null,
  indexed_at integer not null
);
```

Optional vector table:

```sql
create virtual table if not exists document_vec using vec0(
  embedding float[<dimensions>]
);
```

`document_vec.rowid` should match `document.rowid`.

Metadata keys to add:

- `schema_version`
- `extractor_version`
- `ranking_version`
- `vector_state`: `enabled`, `disabled`, `unavailable`, `stale`
- `embedding_dimensions`
- `embedding_model`
- `embedding_base_url`
- `document_prefix`
- `query_prefix`
- `source_path`
- `source_data_version`
- `source_mtime_ms`

## Document Extraction

Current Telescope extraction is optimized for literal search. Semantic extraction should include contextual fields so embeddings understand the document.

Recommended document text:

```txt
Title: <session title>
Role: <user|assistant>
Directory: <workspace directory>
Part type: <text|tool|reasoning>
Tool: <tool name, if any>

<part text or tool text>
```

Initial extraction rules:

- `text`: include text unless ignored.
- `tool`: include tool name plus meaningful completed output/error and selected metadata for `apply_patch`, `edit`, and `write`.
- `reasoning`: skip initially or keep FTS-only; revisit after quality testing.
- Large tool content: chunk later if needed, but avoid adding speculative chunking in the first pass.

Suggested document ID:

```txt
telescope:<session_id>:<message_id>:<part_id>:<chunk_index>
```

## Embedding Runtime

Reuse the reference project's local embedding pattern.

Environment variables:

```txt
OPENCODE_TELESCOPE_EMBED_BASE_URL=http://127.0.0.1:8081
OPENCODE_TELESCOPE_EMBED_MODEL=nomic-embed-text-v1.5
OPENCODE_TELESCOPE_DISABLE_VECTOR=1
OPENCODE_TELESCOPE_SQLITE_LIB=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
OPENCODE_TELESCOPE_SQLITE_VEC_EXT=/path/to/vec0
OPENCODE_TELESCOPE_HYBRID_ALPHA=0.45
```

Embedding prefixes:

```txt
documentPrefix = "search_document: "
queryPrefix = "search_query: "
```

Recommended local server command:

```bash
llama-server \
  -m "$HOME/.local/share/opencode-telescope/models/nomic-embed-text-v1.5.f16.gguf" \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ub 8192 \
  --host 127.0.0.1 \
  --port 8081
```

Important SQLite runtime constraint:

- `sqlite-vec` can require extension-capable SQLite.
- Bun's `Database.setCustomSQLite(path)` is process-wide.
- Configure it before opening sidecar DBs that need extensions.
- Avoid changing OpenCode's source DB or global config.

## Retrieval And Ranking

Telescope should support three conceptual retrieval sources:

1. Keyword/FTS candidates
2. Vector semantic candidates
3. Recency/default candidates for empty query

For non-empty query:

```txt
keyword = searchFts(query)
vector = vectorReady ? searchVector(embedQuery(query)) : []
merged = union by part_id/doc_id
ranked = hybridScore(merged)
```

Do not do this:

```txt
if keyword is empty, return empty
```

Suggested scoring:

```txt
score =
  (1 - alpha) * keywordScore
  + alpha * vectorScore
  + exactBoost
  + titleBoost
  + roleBoost
  + recencyBoost
```

Initial defaults:

- `alpha = 0.45`
- `exactBoost`: small boost for literal query substring in title/text
- `roleBoost`: optional, only when owner filter is active
- `recencyBoost`: small logarithmic or bucketed boost, not enough to override strong semantic relevance

Normalize keyword and vector scores independently before blending.

## Result Mapping

Existing `SearchResult` should stay the public UI result shape.

For FTS-backed results:

- Keep literal snippet and highlight behavior.

For vector-only results:

- Use the document text as excerpt/snippet.
- Set `matchStart = -1` or use an empty match range internally if needed.
- Set `previewHighlight = false`.
- Consider a future UI label like `semantic`, but do not require it in phase 1.

Preview behavior should remain unchanged:

```txt
select result -> loadConversationAround(result) -> preview exact conversation context
open result -> navigate to session and jump to target part
```

## Search Modes

Initial implementation can be automatic:

- If vector dependencies are ready: use hybrid.
- If vector dependencies are missing: use FTS only.

Later user-facing modes:

- `keyword`: FTS only.
- `semantic`: vector only.
- `hybrid`: blended FTS + vector.

Avoid adding UI mode toggles until the backend is stable. A status line is enough at first.

## Dependency And Status UX

Borrow the smart picker's status model, but keep Telescope's UI minimal.

Useful statuses:

- `keyword ready`
- `vector disabled`
- `sqlite-vec unavailable`
- `embedding server unavailable`
- `vector index stale`
- `indexing in background`

Status should be visible in debug logs first. A compact UI chip can come later.

## Indexing Strategy

Phase 1 should prefer correctness and simple rebuilds:

1. Detect stale sidecar with existing source metadata.
2. Rebuild FTS and document tables from source DB.
3. If vector is enabled and dependencies are healthy, embed all current documents and replace vector rows.
4. If vector dependency fails, keep FTS usable and mark vector state unavailable/stale.

Later incremental indexing:

- Track session/message/part update times.
- Rebuild documents at session granularity when anything in a session changes.
- Re-embed only changed documents.
- Periodically reconcile deletions.

## Rollout Phases

### Phase 1: Foundation

- Add semantic config parsing.
- Add embedding client.
- Add vector dependency checks.
- Add sidecar metadata for vector state and embedding profile.
- Keep behavior keyword-only by default.

### Phase 2: Document Table

- Add canonical `document` table.
- Convert current index rebuild to insert documents first, then populate `document_fts` and `document_index`.
- Keep tests proving current FTS behavior is unchanged.

### Phase 3: Vector Index

- Load `sqlite-vec` if available.
- Create `document_vec` based on embedding dimensions.
- Embed documents through local `llama-server`.
- Store vector rows keyed by `document.rowid`.
- Mark vector metadata accurately.

### Phase 4: Hybrid Query

- Add `searchVector`.
- Add independent keyword and vector retrieval.
- Add score normalization and blending.
- Ensure vector-only results can appear.
- Preserve current pagination contract where possible.

### Phase 5: UX And Diagnostics

- Add debug logs for each phase: index, embedding, vector query, ranking.
- Add compact status text/chips only after backend behavior is stable.
- Document setup and degradation behavior in README.

## Test Plan

Unit tests:

- Existing FTS tests remain green.
- Semantic document extraction includes title, role, directory, and part text.
- Hybrid ranking returns vector-only rows when keyword rows are empty.
- Hybrid ranking blends keyword and vector rows without duplicate results.
- Vector unavailable falls back to keyword without throwing.
- Changed embedding profile marks vector state stale or rebuilds vector rows.

Integration/manual tests:

- Start `llama-server` with a local embedding model.
- Search with a synonym/paraphrase query that has no exact FTS hit.
- Confirm result opens the correct session and preview target.
- Stop `llama-server` and confirm keyword search still works.
- Delete sidecar and confirm it rebuilds from OpenCode DB only.

## Risks

- Embedding rebuild may be slow for large histories.
- `Database.setCustomSQLite` is process-wide and must be handled carefully.
- Vector-only snippets do not have literal highlights.
- Pagination is harder when merging keyword and vector rankings.
- Local embedding quality depends heavily on model choice and prompt prefixes.

## Open Questions

- Should semantic search index assistant reasoning, or keep it hidden/noisy?
- Should tool outputs be chunked immediately or only after measuring real sidecar size?
- Should semantic search default to hybrid automatically or require an env flag first?
- Should the sidecar vector work run in-process or a child process to isolate custom SQLite?
- How should we expose semantic status without cluttering the Telescope UI?

## Recommended First Implementation

Start with a minimal, safe path:

1. Add semantic config and embedding client.
2. Add `document` table and refactor FTS rebuild through document extraction.
3. Add optional vector table creation and vector rebuild behind env flag.
4. Add vector query and hybrid ranking that does not depend on FTS hits.
5. Keep UI unchanged except for debug/status logs.

This gives Telescope true semantic retrieval while preserving the current fast local keyword search as the default fallback.
