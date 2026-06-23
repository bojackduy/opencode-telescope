# Developer Guide

## Known Issues & Tasks

---

### 1. Performance: lag with large session history

**Problem:** When the user has many conversations or long sessions, both search and preview degrade significantly.

**Root causes:**
- **Search query** (`visibleTextRows` in `search.ts:425`): Uses `LIKE '%token%'` across all `part` rows joined with `message` and `session`. No FTS index. With thousands of sessions, this is a full scan of JSON-extracted text.
- **Preview expansion** (`loadConversationWindow` in `search.ts:127`): Expands preview window by 5 on each scroll-to-edge (polls every 400ms). Each expansion re-runs two SQL queries with `ORDER BY time_created DESC`. For sessions with 500+ messages, this gets slow.
- **Database connection**: Opens a new `Database` for every query (search, load-more, preview). No connection pooling.
- **Debouncing**: Search debounce is 180ms, load-more is 100ms, preview polls every 400ms — these fire even when the user isn't actively interacting.

**What to do:**
- Investigate SQLite FTS5 for full-text search index on `part.data` text
- Consider connection reuse / statement caching
- Profile with `OPENCODE_TELESCOPE_DEBUG=1` to find actual bottlenecks
- Look into batch preview loading instead of incremental expansion

**Relevant files:**
- `search.ts` — all queries
- `telescope.tsx` — debounce timing, load-more logic
- `ui/debug.ts` — debug timing

---

### 2. Pagination: cursor resets instead of continuing

**Problem:** When loading a new page of results (either in the result list or preview), the cursor/offset jumps back to 0 instead of continuing from where it was. This makes it impossible to browse through pages sanely — the user loses their place.

**Root causes:**
- **Result list** (`telescope.tsx:53-99`): The `createEffect` on query change always calls `searchSessionMessages` / `recentSessionMessages` with `offset: 0`. The "load more" effect (line 121-148) correctly uses `offset: total`, but only fires when near the bottom. The initial load always resets.
- **Preview** (`telescope.tsx:151-171`): When `selectedResult()` changes, `previewRange` resets to `{ before: 3, after: 6 }`. If the user scrolls down the result list then scrolls up, the preview fetches from scratch.
- **No scroll restoration**: No saved scroll position or cursor state between navigation.

**What to do:**
- Preserve offset between pagination steps instead of resetting
- Add scroll position memory for result list
- For preview: keep the existing preview loaded while the new one loads (reduce visual blink)
- Consider cursor-based pagination (using `time_created` + `id`) instead of offset-based for stable results

**Relevant files:**
- `telescope.tsx:53-99` — initial query effect (resets offset to 0)
- `telescope.tsx:121-148` — load-more effect (correct, but only after initial reset)
- `telescope.tsx:151-171` — preview load effect (resets range on every selection change)
- `search.ts:425-461` — `visibleTextRows` SQL with LIMIT/OFFSET

---

### 3. Semantic search with embeddings

**Goal:** Add semantic (vector) search alongside existing fuzzy text search so users can find conversations by meaning, not just keyword match.

**Inspiration:** Look at how `open-smart-history-search` (or similar projects) implement embedding-based search for chat/session history.

**What to learn/implement:**
- Generate embeddings for conversation parts (user messages, assistant responses) at write time or scan time
- Store embeddings in SQLite (or a separate vector store)
- At search time, embed the query and find nearest neighbors (cosine similarity)
- Hybrid approach: combine keyword AND semantic search results

**Considerations:**
- Which embedding model? (local vs API, size, dimension)
- When to embed? (on session save vs batch reindex)
- Where to store vectors? (SQLite FTS5 + custom extension, or separate db)
- Performance: embedding generation at search time vs pre-computed

**Relevant files:**
- `search.ts` — current search pipeline (this is where semantic search would integrate)
- `telescope.tsx` — UI would need mode switching or result merging

---

### 4. OpenCode truncation: can't jump to truncated messages

**Problem:** OpenCode's TUI only renders a limited window of conversation history. Older messages exist in the SQLite database but are not rendered in the session view. When Telescope finds a match in an older message and tries to jump to it (`jumpToRenderedTarget` in `render-target.ts:20`), it can't find the DOM node because it doesn't exist.

**Root causes:**
- **`jumpToRenderedTarget`** (`ui/render-target.ts:20-45`): Polls the render tree recursively looking for the message by ID. If OpenCode truncated it, the node never appears → polling times out → user lands at the top of the session instead of the matched message.
- **OpenCode behavior**: The session view only renders a subset of messages (maybe the last N). The rest are in the DB but not in the virtual DOM.

**What to do:**
- Investigate OpenCode's truncation threshold
- Options:
  - Send a command/key sequence to scroll up / load more before jumping
  - If OpenCode exposes an API to load a specific message range, use it
  - As a fallback: highlight the session name and suggest the user scroll up manually
  - Patch OpenCode to preserve the target ID and auto-scroll on render

**Relevant files:**
- `ui/render-target.ts` — `jumpToRenderedTarget`, `findRenderableTarget`, polling logic
- `telescope.tsx:199-206` — `open()` function that navigates then jumps
