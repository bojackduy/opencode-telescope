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

### 2. Pagination and preview scrolling: cursor resets instead of continuing

**Problem:** When loading a new page of results (either in the result list or preview), the cursor/offset should continue from the current position. The old bug reset the cursor back to the beginning. That is only partially fixed: it no longer resets to the beginning, but preview scrolling can still reset back to the previous/last position, which traps the user and prevents viewing content near the boundary.

**Current broken preview behavior:**
- User is viewing preview around line/message 5
- Next scroll should move forward to line/message 8
- The loaded content only reaches line/message 7
- Instead of letting the user see line/message 6 and 7, the preview resets back to line/message 5
- Result: the user cannot view the tail content and gets stuck at the old position

This is still a UX bug. Pagination should never jump backward or trap the user at the previous cursor.

**Root causes:**
- **Result list** (`telescope.tsx:53-99`): The `createEffect` on query change always calls `searchSessionMessages` / `recentSessionMessages` with `offset: 0`. The "load more" effect (line 121-148) correctly uses `offset: total`, but only fires when near the bottom. The initial load always resets.
- **Preview** (`telescope.tsx:151-171`): When `selectedResult()` changes, `previewRange` resets to `{ before: 3, after: 6 }`. If the user scrolls down the result list then scrolls up, the preview fetches from scratch.
- **Preview range model**: The preview is modeled as a bounded `before` / `after` window around the match. This makes it easy to lose scroll continuity when the user reaches the edge of the loaded range.
- **No scroll restoration**: No saved scroll position or cursor state between navigation.

**Expected preview UX:**
- The selector should find and anchor the matched message
- The preview should open around that match and highlight it
- From there, the user should be able to scroll upward and downward through the whole conversation
- Loading more content should be seamless, similar to viewing the conversation in OpenCode
- The match should remain locatable, but the preview should not be limited to a tiny fixed window around the match

**What to do:**
- Preserve offset between pagination steps instead of resetting
- Add scroll position memory for result list
- For preview: keep the existing preview loaded while the new one loads (reduce visual blink)
- Consider cursor-based pagination (using `time_created` + `id`) instead of offset-based for stable results
- Revisit whether `previewRange: { before, after }` is the right abstraction
- Consider a conversation-preview model with a stable anchor message and independent upward/downward cursors
- Allow preview pagination to append/prepend loaded parts without resetting scroll position
- Investigate why preview can enter a state where more content cannot be rendered

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

---

### 5. Configurable keybindings

**Goal:** Let users customize Telescope keybindings without editing source code.

**Problem:** Keybindings are currently hardcoded in two places:
- **Global open shortcut** (`tui.tsx:33`): The plugin always registers `<leader>f` as the open shortcut.
- **Telescope dialog shortcuts** (`telescope.tsx:222-267` and `telescope.tsx:295-306`): Navigation, preview scrolling, open, close, and mode-switching keys are fixed in code.

This makes the plugin less flexible for users who prefer different navigation styles or who already use the default keys for something else.

**Preferred config location:** Use a plugin-owned config file instead of putting all plugin settings in `opencode.json` / `tui.json`.

Recommended path:

```txt
~/.config/opencode/opencode-telescope/config.json
```

This follows the same pattern as plugins like `opencode-quota`, which keeps plugin-specific settings in its own folder:

```txt
~/.config/opencode/opencode-quota/quota-toast.json
```

`opencode.json` / `tui.json` should stay focused on core opencode config and plugin registration. The plugin itself should read its own config file.

**Example config:**

```jsonc
{
  "openKey": "<leader>f",
  "keys": {
    "moveDown": ["down", "j"],
    "moveUp": ["up", "k"],
    "scrollPreviewDown": ["d"],
    "scrollPreviewUp": ["u"],
    "open": ["enter", "return"],
    "close": ["q", "escape"],
    "insertMode": ["/"],
    "normalMode": ["ctrl+q"]
  }
}
```

**What to do:**
- Add a config loader, likely `ui/config.ts`
- Resolve config from `$XDG_CONFIG_HOME/opencode/opencode-telescope/config.json`, falling back to `~/.config/opencode/opencode-telescope/config.json`
- Use defaults when the file does not exist
- Ignore invalid fields and keep defaults instead of crashing the plugin
- Pass parsed config from `tui.tsx` into `Telescope`
- Replace the hardcoded global open binding with `config.openKey`
- Replace hardcoded dialog key checks with config-driven checks
- Update footer/help text so displayed keys match the user config
- Document the config file in `README.md`
- Add tests for config parsing and key matching

**Key matching requirements:**
- Continue supporting simple names like `j`, `k`, `down`, `up`, `enter`, `return`, and `escape`
- Add support for modifier strings like `ctrl+q`
- Keep the first implementation small; do not build a full keybinding DSL unless needed

**Relevant files:**
- `tui.tsx` — parse config, register `openKey`, pass config into `Telescope`
- `telescope.tsx:222-267` — main keyboard handler with hardcoded bindings
- `telescope.tsx:295-306` — input-mode keyboard handler
- `ui/keyboard.ts` — add configurable key matching helper
- `README.md` — document config file and examples
