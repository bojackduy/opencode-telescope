# Project Handoff: Current State And Future Intent

Last updated: 2026-07-24

## Purpose

This document captures the current implementation context for `opencode-telescope`, the intent behind recent changes, known risks, and future work across UI, UX, performance, logic, and reliability.

Use this as the starting point for the next development session.

## Product Direction

Telescope should stay a fast, keyword-first OpenCode TUI plugin for searching local conversation history.

Core principles:

- Bare search should be low-noise and fast.
- Bare search searches user prompts and assistant replies only.
- Thoughts, patches, file names inside patches, and tool content are opt-in via explicit scopes.
- Search should use Telescope's last-good sidecar index in normal operation, including while incremental synchronization runs. A bounded source-DB fallback is allowed only when no usable sidecar rows exist.
- Semantic/vector search is optional and opt-in only.
- Preview and jump behavior should be reliable even when OpenCode does not render every indexed part.

## Current User-Facing Query Syntax

Bare search:

```txt
timeout
```

Searches only user prompts and assistant replies.

Scoped search:

```txt
user:timeout
assistant:timeout
thought:indexing
patch:SearchResponse
in:patch SEARCH_WORKER_TIMEOUT_MS
tool:apply_patch SearchResponse
```

One-line mixed clauses use OR semantics:

```txt
timeout patch:SearchResponse
user:auth patch:SearchResponse
patch:"SearchResponse kind" user:"auth timeout"
timeout OR patch:SearchResponse
```

Literal search for scope-like text:

```txt
text:patch:SearchResponse
literal:user:timeout
\patch:SearchResponse
```

Unknown prefixes stay plain text:

```txt
url:https://example.com
```

## Current Architecture

Important files:

- `tui.tsx`
  - Registers the plugin command and keybinding.
  - Opens `<Telescope />` in an OpenCode dialog.

- `telescope.tsx`
  - Main picker UI, state machine, keyboard handling, preview virtualization, search worker/index worker coordination, result pagination, and jump behavior.
  - This file is large and high-risk. Prefer extracting pure helpers before adding more complex behavior.

- `search/query.ts`
  - Query parser, labels, and hints.
  - Handles scoped tokens, mixed OR clauses, quotes, literal escapes, and owner-filter override semantics.

- `search/queries.ts`
  - Sidecar search execution, preview loading, keyword index rebuilds, semantic/hybrid search orchestration.
  - Search is sidecar-first; typed search should not query OpenCode source tables directly.

- `search/schema.ts`
  - Sidecar schema and migrations.
  - Current `SEARCH_INDEX_VERSION` is `8`.

- `search/text.ts`
  - Text extraction, row-to-result conversion, snippets, FTS query generation, query expansion.

- `search/vector.ts`
  - Vector search, hybrid blend, optional `sqlite-vec` setup/rebuild utilities.

- `search-worker.ts`
  - Initial search/recent queries from worker.

- `source-search-worker.ts`
  - Bounded source-DB fallback worker used while the sidecar is unavailable or slow.

- `index-worker.ts`
  - Batched incremental keyword synchronization and one-time scoped-FTS construction.

- `worker-service.ts`
  - Persistent search, preview, and index workers shared across dialog openings.
  - Promise-based request routing, index synchronization coalescing, and plugin-lifecycle cleanup.

- `components/preview.tsx`
  - Preview rendering for user, assistant, reasoning/thought, and tool parts.

- `ui/render-target.ts`
  - Preview target scrolling and session jump target fallback logic.

- `ui/preview-utils.ts`
  - Preview text clipping, patch parsing, token matching.

- `ui/debug.ts`
  - Debug logging to console or JSONL file.

## Recent Implemented Changes

### Scoped And Mixed Search

Implemented:

- `SearchKind = "user" | "assistant" | "thought" | "patch"`.
- Bare search filters to `kind IN ('user', 'assistant')`.
- Thoughts/reasoning indexed as `thought`.
- Patch/edit/write tools indexed as `patch`.
- `user:`, `assistant:`, `thought:`, `patch:`, `in:<scope>`, and `tool:<name>` parsing.
- One-line mixed clauses with OR semantics.
- Quoted scoped values.
- Literal escapes via `text:`, `literal:`, and leading backslash.
- Search hints via `searchQueryHint()`.

Tests:

- `search/query.test.ts`
- scoped integration coverage in `search.test.ts`

### Vector/Hybrid Filtering And Pagination

Implemented:

- `searchVector()` accepts `directory`, `role`, `kinds`, and `offset` options.
- Bare hybrid vector rows are restricted to current directory, owner role, and `kind IN ('user', 'assistant')`.
- Hybrid search now builds an offset-aware ranking window and slices after blending, reducing duplicate load-more pages.
- `buildVectorSearchPlan()` was added for testable SQL plan generation.

Tests:

- `vector search plan` tests in `search.test.ts`.

Remaining risk:

- Vector index build/rebuild lifecycle still needs deeper work. See `Known Issues`.

### Persistent Search And Incremental Indexing

Implemented:

- `worker-service.ts` prewarms and preserves search/preview/index workers for the full plugin lifecycle.
- Search, result pagination, and preview pagination no longer call SQLite from `telescope.tsx`.
- Existing sidecar rows remain searchable while synchronization runs; active indexing never forces source fallback.
- Source freshness uses a `part.rowid` checkpoint instead of source DB `mtimeMs` or connection-local `PRAGMA data_version`.
- Normal synchronization reconciles the latest 256 parts and appends new rows in 500-row transactions with cooperative sleeps.
- OpenCode update/removal events debounce and coalesce synchronization requests.
- Scoped FTS indexes hashed directory, role, kind, and tool tokens, so filtering happens inside FTS before ranking.
- Scoped FTS is built in the background while the previous FTS remains queryable, then selected atomically through metadata.
- `searchSourceFallbackWithStatus()` remains bounded and worker-only for first-run/missing-index behavior.
- Expected worker failures and missing indexes degrade to fallback/empty indexing state; the picker no longer displays `database search failed`.

Measured on the real local corpus (5.1GB source DB, 208,192 parts, approximately 74,000 indexed documents):

- Warm persistent-worker search: about 8-25ms.
- Cold scoped search: about 58-120ms, down from 950-1,120ms.
- Normal incremental synchronization: about 90-110ms, down from 101 seconds after eliminating FTS `id` scans.
- Largest-session indexed preview query: about 33ms, down from about 390ms.

Logs:

```txt
bootstrap:search:source-fallback
query:source-fallback
source-worker:error
```

### Hidden Thought/Tool Jump Fallback

Implemented:

- `jumpTargetIDs(item, previewParts)` creates fallback jump targets.
- Opening a result now tries exact target first, then visible same-message targets, then message id, then nearby visible targets.
- This handles thought/reasoning results that Telescope can preview but OpenCode may not render in the main session view.
- Tool/file matches also fall back if exact tool target is absent or collapsed.

Tests:

- `ui/render-target.test.ts`

### Preview Offset Fix

Implemented in `telescope.tsx`:

- Added `previewGeneration` to invalidate stale preview timers after selecting a different result.
- Reset `previewScroll.scrollTo(0)` on selected result change before loading/alignment.
- Guarded delayed preview callbacks with generation checks.
- If exact preview target alignment misses, alignment re-applies the estimated target window and retries.
- Added debug logs for manual verification.

Debug labels added:

```txt
preview:generation
preview:reset-scroll
preview:stale-callback
preview:target-scroll:queue
preview:target-scroll:estimated
preview:target-scroll:retry-estimated
preview:target-scroll:cancel
preview:target-scroll:estimated-skip
```

Manual scenario that was fixed:

```txt
search 2+ results -> result 1 -> result 2 -> d/u in preview -> result 1
```

Expected behavior: result 1 preview re-centers on its match instead of retaining result 2's preview scroll offset.

### Preview Navigation Isolation

- Initial preview loading runs through the persistent preview worker after a 100ms navigation debounce.
- Selecting another row invalidates stale preview results without starting or terminating workers from the keypress path.
- The old preview is cleared immediately so it is not re-rendered against the newly selected result.
- Initial context is limited to 6 parts before and 10 after the hit; normal preview pagination remains available.
- The loading/empty state renders an 800-character plain-text excerpt instead of parsing the full result as Markdown.
- Rich user, assistant, and reasoning content is clipped to bounded excerpts before Markdown rendering.
- Preview source reads traverse indexed messages and per-message parts instead of sorting every part in a session.

## Debugging Instructions

Run OpenCode with Telescope debug logging:

```bash
OPENCODE_TELESCOPE_DEBUG=1 \
OPENCODE_TELESCOPE_LOG="/tmp/opencode-telescope-preview.jsonl" \
opencode /path/to/workspace
```

If testing local uncommitted plugin changes, ensure `tui.json` points at the local checkout:

```jsonc
{
  "plugin": ["/Users/duytrinh/Code/opencode-telescope"]
}
```

Important: if `tui.json` uses `@bojackduy/opencode-telescope`, it tests the installed npm package, not local changes.

Useful log labels:

```txt
plugin:setup:start
plugin:dialog:open:start
bootstrap:search:start
bootstrap:search:done
query:fts:exec
query:vector:results
preview:new-item
preview:generation
preview:reset-scroll
preview:stale-callback
preview:target-scroll:queue
preview:target-scroll:estimated
preview:target-scroll:retry-estimated
preview:target-scroll:cancel
preview:anchor:disengage
preview:anchor:re-anchor
preview:anchor:settled
preview:anchor:gave-up
preview:load-before:preserve-target
jump:start
jump:heuristic-hit
jump:done
jump:target
jump:target:resolve
jump:target-missing
jump:plugin-failure
```

Every `jump:*` line and every `preview:*` line on the current item carries a
`trace` id, so one full navigation outcome can be reconstructed by filtering
on that id. Debug writes are buffered and flushed every 200ms (or on exit) to
avoid perturbing low-power timing; render-tree data is logged as candidate
counts, match kind, and confidence — never as raw conversation content.

### Manual jump validation matrix

| Target type                 | Same session                     | Cross session                    |
| --------------------------- | -------------------------------- | -------------------------------- |
| User text                   | Jump exact prompt                | Jump exact prompt                |
| Assistant text              | Exact part or turn fallback toast | Exact part or turn fallback toast |
| Thought (thinking shown)    | Likely part or turn fallback     | Likely part or turn fallback     |
| Thought (thinking hidden)   | Turn fallback toast expected     | Turn fallback toast expected     |
| Tool: edit/apply_patch/write | Exact diff part or turn fallback | Exact diff part or turn fallback |
| Tool: bash/etc.             | Turn fallback toast expected     | Turn fallback toast expected     |
| Tool details hidden         | Turn fallback toast expected     | Turn fallback toast expected     |
| Outside latest 100 messages | Issue #4 warning toast           | Issue #4 warning toast           |

Acceptance for each row: an exact jump must never be reported without a
matched rendered candidate; every turn fallback shows the info toast; the
`jump:done` log records the outcome and confidence for the trace id.

### Preview anchoring checklist

1. Select a match, wait for layout to settle — the matched part must remain
   anchored at roughly the upper third.
2. Rapidly move between results — each preview must settle on its own match.
3. Scroll the preview with keys or mouse wheel — anchoring must disengage
   (log `preview:anchor:disengage`).
4. Load earlier context while the anchor is engaged — the match must stay in
   view (log `preview:load-before:preserve-target`).
5. Load earlier context after scrolling manually — the current viewport
   position must be preserved, not the match.

## Known Issues And Risks

### High Priority

1. Vector index lifecycle is incomplete.

Evidence:

- `setupVectorTable()` exists in `search/vector.ts` but was not fully wired during the latest scan.
- Keyword rebuild deletes/reinserts `document` rows, while vector tables may remain stale unless a vector rebuild occurs.
- Existing vector rows join by `rowid`, so stale vectors can attach to the wrong document after rebuilds.

Intent:

- On keyword rebuild, mark vector state stale or drop `document_vec` and vector metadata.
- When vector is enabled, trigger a vector rebuild after keyword rebuild.
- Validate vector metadata against source/index version, embedding model, base URL, and prefixes.

2. FTS pagination can starve valid ordered-token results.

Evidence:

- `ftsQuery()` uses FTS `AND` terms but does not enforce token order.
- `rowToSearchResult()` later requires ordered token matching.
- SQL `LIMIT/OFFSET` happens before this post-filtering.

Impact:

- Out-of-order rows can consume the page and then be dropped, hiding valid rows beyond the raw SQL limit.

Intent:

- Over-fetch keyword FTS rows before post-filtering, or move ordered-token matching closer to query pagination.
- Add regression coverage where out-of-order rows fill the first SQL page.

3. `telescope.tsx` is too large and stateful.

Impact:

- Preview timers, worker state, virtual layout, and keyboard handling are interleaved.
- Small changes can create stale callback or scroll-state bugs.

Intent:

- Extract preview virtualization state machine into pure helpers/hooks.
- Extract result pagination and worker orchestration into separate modules.

### Medium Priority

4. Title-only FTS matches can consume pages and disappear.

Evidence:

- `document_fts` indexes `session_title`.
- `rowToSearchResult()` validates/highlights against `row.text` only.

Intent:

- Decide whether title search is a supported feature.
- If yes, include title in result matching/snippets.
- If no, make `session_title` unindexed in FTS.

5. Resolved: source staleness no longer depends on `PRAGMA data_version` or DB mtime.

Evidence:

- `source_data_version` is persisted and later compared.
- SQLite `data_version` is connection-local.

Resolution:

- Incremental synchronization persists `source_max_part_rowid` and is triggered by OpenCode events plus plugin startup reconciliation.

6. Resolved: all result pagination runs through the persistent search worker.

Resolution:

- `searchInWorker()` handles initial, next-page, and previous-page requests with request IDs.

7. Pagination ordering lacks stable tie-breakers.

Evidence:

- FTS orders by rank and timestamp.
- Recent rows order by timestamp only.

Intent:

- Add `id` as a final deterministic tie-breaker.

8. Preview pagination can stop early after long runs of invalid rows.

Evidence:

- Preview before/after fetches raw rows, filters invalid rows, then decides `hasMore` from valid row count.

Intent:

- Fetch in small loops until enough valid rows are found or source is exhausted.

### Low Priority

9. Quoted uppercase `"OR"` cannot be searched literally.

Current behavior:

- Tokenizer strips quotes before parser sees `OR`.
- Exact token `OR` becomes a separator.

Intent:

- Preserve quote metadata in tokenization if literal `"OR"` matters.
- Alternatively document `\OR` as the literal escape.

10. Existing focused handoff is stale.

File:

- `docs/search-bar-suggestions-handoff.md`

Status:

- Some listed tasks, such as `searchQueryHint()`, are now implemented.

Intent:

- Either update it to current state or replace it with this broader handoff.

## Future Work: UI And UX

### Search Bar Hints And Query Chips

Current state:

- `searchQueryHint()` exists.
- UI has `searchHint` memo and hint row support in recent code history, but verify actual visible behavior before adding more.

Future intent:

- Make parsed query interpretation visible with compact chips:

```txt
[text: timeout] [patch: SearchResponse]
```

- For mixed OR queries, show:

```txt
OR: text contains "timeout" | patch contains "SearchResponse"
```

- Keep it low-noise and single-line.

### Empty State Examples

Show pasteable one-line examples when search is empty:

```txt
timeout
user:timeout
patch:SearchResponse
user:auth patch:SearchResponse
text:patch:SearchResponse
```

### Result Badges

Show `user`, `assistant`, `thought`, `patch`, and `tool:<name>` badges in result rows.

Intent:

- Make it obvious why a scoped query returned a row.
- Make thought/patch/tool results less surprising.

### Hidden Target Notice

For thought/tool results, show a small preview/open hint:

```txt
Enter opens nearest visible message if OpenCode hides this part.
```

Only show this for `partType === "reasoning"` or `partType === "tool"`.

### Recent Searches

Potential feature:

- Store recent queries locally in plugin config/cache.
- Support quick recall in empty input or with a keybinding.

Keep privacy/local-first expectations clear.

### Saved Searches

Potential feature:

- Saved query names like `patch work`, `my asks`, `thoughts`.
- Should be plugin-owned config, not OpenCode global config.

## Future Work: Performance

### Worker-Based Pagination

Move load-more and load-before result pagination into `search-worker.ts`.

Reason:

- Avoid UI stalls with vector/hybrid search.
- Centralize stale request handling.

### FTS Over-Fetch And Post-Filter Budget

For ordered-token validation, fetch more raw FTS rows than requested and continue until enough valid results are produced or a cap is reached.

Suggested initial cap:

```txt
rawLimit = min(max(limit * 4, 100), 1000)
```

Add debug logs for dropped rows so starvation is visible:

```txt
query:fts:post-filter
```

### Preview Virtualization Extraction

Extract pure helpers for:

- estimating part height
- building preview layout
- computing virtual window
- computing target-centered scrollTop

This makes regression tests possible without rendering OpenTUI.

### Vector Rebuild Scheduling

If vector remains opt-in, build asynchronously and expose status:

```txt
vector: disabled | unavailable | stale | indexing | enabled
```

Avoid blocking keyword search while vectors build.

## Future Work: Logic And Reliability

### Sidecar Migration Robustness

Current migration patches known old shapes, especially `kind`.

Future intent:

- Validate all required columns in `document`, `document_fts`, and `document_index`.
- If a sidecar is too old, safely recreate plugin-owned sidecar tables.
- Avoid destructive operations on OpenCode source DB.

### Preview Timer Discipline

Current fix uses generation guards for preview callbacks.

Future intent:

- Track all preview timers explicitly in one cleanup set.
- Prefer a helper like:

```ts
schedulePreviewTask(source, callback)
```

That helper should capture generation and selected item id automatically.

### Open/Jump Observability

Current `jumpToRenderedTarget()` logs `jump:target` and `jump:target-missing`.

Future intent:

- Include result kind, part type, tool, target list, and selected session in logs.
- Add user-visible fallback message only if jump fails repeatedly.

### Scoped Query Parser Robustness

Future parser improvements:

- Preserve quote metadata so literal `"OR"` can be distinguished from operator `OR`.
- Consider lowercase `or` as an operator only if the UX really needs it.
- Add a maximum clause count to prevent pathological queries from creating too many FTS calls.

## Manual Regression Checklist

Search behavior:

```txt
timeout
user:timeout
assistant:timeout
thought:indexing
patch:SearchResponse
tool:apply_patch SearchResponse
timeout patch:SearchResponse
user:auth patch:SearchResponse
patch:"SearchResponse kind" user:"auth timeout"
text:patch:SearchResponse
\patch:SearchResponse
url:https://example.com
```

Preview alignment:

```txt
result 1 -> result 2 -> d/u -> result 1
result 1 -> result 2 -> d/u -> result 3 -> result 1
thought:<term> -> d/u -> another result -> back
patch:<term> -> d/u -> another result -> back
tool:apply_patch <term> -> open
```

Jump behavior:

```txt
user result -> Enter
assistant result -> Enter
thought result -> Enter
patch/tool result -> Enter
```

Expected:

- User/assistant exact targets jump normally.
- Thought/tool results open the session and land at exact target if rendered, or nearest visible fallback if not.

Pagination:

```txt
search common term -> move down until load-more -> move up into previous cached rows
search common term with vector disabled -> no duplicates
search common term with vector enabled -> no obvious duplicate pages
```

## Verification Commands

Standard checks:

```bash
bun run typecheck
bun test
git diff --check
npm pack --dry-run
```

Debug run:

```bash
OPENCODE_TELESCOPE_DEBUG=1 \
OPENCODE_TELESCOPE_LOG="/tmp/opencode-telescope-preview.jsonl" \
opencode /path/to/workspace
```

Useful inspection:

```bash
git status --short
git diff --stat
```

## Current Worktree Note

At the time this handoff was written, `git status --short` showed an untracked `.opencode/` directory. It was not created or modified as part of the documented code changes and should not be removed unless the user explicitly asks.

## Recommended Next Task

The best next engineering task is **vector index lifecycle correctness**.

Why:

- The search UX and scoped parser are now much better.
- Preview/jump reliability has been improved.
- The biggest remaining correctness risk is stale or unwired vector data.

Suggested acceptance criteria:

- Enabling vector search on a fresh sidecar starts vector indexing after keyword indexing.
- Keyword rebuild marks vector state stale or clears old vector rows.
- Vector search does not use stale embeddings after source changes.
- `vectorState` shown in the UI reflects `disabled`, `unavailable`, `stale`, `indexing`, or `enabled` accurately.
- Existing keyword-only behavior remains fast and unaffected when vector is disabled.
