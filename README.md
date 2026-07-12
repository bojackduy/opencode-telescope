# opencode-telescope

OpenCode TUI plugin for fuzzy and semantic search across local conversation history, session transcripts, and past AI coding chats.

Install the npm package `@bojackduy/opencode-telescope` to grep OpenCode chat history, find old code snippets, search by meaning with local embeddings, and jump back to any session instantly.

> Inspired by [telescope.nvim](https://github.com/nvim-telescope/telescope.nvim) — a fuzzy finder for your conversation history.

## Links

- Documentation: https://bojackduy.github.io/opencode-telescope/
- npm: https://www.npmjs.com/package/@bojackduy/opencode-telescope
- GitHub: https://github.com/bojackduy/opencode-telescope
- Issues: https://github.com/bojackduy/opencode-telescope/issues

![Demo](./assets/demo.png)

## Use cases

- **"I know I discussed this somewhere"** — grep all your sessions by keyword
- **"What was that auth caching idea?"** — semantic search can find related chats even when the exact words differ
- **"Find that code snippet"** — search for code you saw in a past LLM response
- **"Revisit a decision"** — find the conversation where you chose approach X
- **"Session journal"** — browse your entire conversation history like a timeline

## Features

- **Fuzzy grep** — search across all session messages by text
- **Semantic memory search** — optional local vector search with `llama-server` embeddings and `sqlite-vec`
- **Hybrid ranking** — blends keyword/FTS matches with semantic vector results when vector search is ready
- **Live preview** — preview the matched conversation result before opening
- **Find & jump** — select any result and jump straight to that session
- **Neovim Telescope-style UX** — familiar `<leader>f` keybind and `/telescope` command
- **Local-first search** — reads your OpenCode session database without sending chat history to a remote service

## Installation

Install from npm as `@bojackduy/opencode-telescope`.

Add the plugin to your `tui.json`:

```jsonc
{
  "plugin": ["@bojackduy/opencode-telescope"],
}
```

> To use it from a local clone:
>
> ```jsonc
> "plugin": ["./path/to/opencode-telescope"]
> ```

## Usage

| Action           | Key / Command                                   |
| ---------------- | ----------------------------------------------- |
| Open search      | `<leader>f` or `/telescope`                     |
| Type to filter   | Fuzzy match against conversation text           |
| Navigate results | `↑` / `↓` or `j` / `k`                          |
| Preview          | Select a result to see the conversation preview |
| Open             | Press `Enter` to jump to the selected session   |
| Owner filter     | Press `o` to cycle `all` / `you` / `assistant`  |

## Semantic Search

Semantic search is optional. Keyword and fuzzy search work out of the box; when vector dependencies are available, Telescope builds a local sidecar vector index and uses hybrid ranking so meaning-based matches can appear even when the query does not share exact words with the original chat.

The semantic path stays local-first:

- OpenCode's SQLite database is opened read-only.
- Derived keyword and vector indexes are stored in Telescope's sidecar database.
- Embeddings are generated through your local `llama-server` endpoint.
- If embeddings or `sqlite-vec` are unavailable, Telescope falls back to keyword search.

Quick setup:

```bash
mkdir -p "$HOME/.local/share/opencode-telescope/models"

huggingface-cli download \
  nomic-ai/nomic-embed-text-v1.5-GGUF \
  nomic-embed-text-v1.5.f16.gguf \
  --local-dir "$HOME/.local/share/opencode-telescope/models" \
  --local-dir-use-symlinks false

llama-server \
  -m "$HOME/.local/share/opencode-telescope/models/nomic-embed-text-v1.5.f16.gguf" \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ub 8192 \
  --host 127.0.0.1 \
  --port 8081
```

Then launch OpenCode normally. Telescope uses `http://127.0.0.1:8081` by default and will rebuild the vector sidecar from your local session history.

Useful environment variables:

```bash
OPENCODE_TELESCOPE_EMBED_BASE_URL=http://127.0.0.1:8081
OPENCODE_TELESCOPE_EMBED_MODEL=nomic-embed-text-v1.5
OPENCODE_TELESCOPE_HYBRID_ALPHA=0.45
OPENCODE_TELESCOPE_DISABLE_VECTOR=1
OPENCODE_TELESCOPE_SQLITE_LIB=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
OPENCODE_TELESCOPE_SQLITE_VEC_EXT=/path/to/vec0
```

See the full tutorial in [`docs/semantic-search.md`](./docs/semantic-search.md).

## Configuration

Telescope reads optional plugin-specific config from:

```txt
~/.config/opencode/opencode-telescope/config.json
```

If `$XDG_CONFIG_HOME` is set, the path is:

```txt
$XDG_CONFIG_HOME/opencode/opencode-telescope/config.json
```

Missing config, invalid JSON, and invalid individual fields are ignored. Defaults are kept for anything not configured.

Example:

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
    "normalMode": ["ctrl+q"],
    "toggleOwner": ["o"]
  }
}
```

Key strings support simple names like `j`, `k`, `down`, `up`, `enter`, `return`, and `escape`, plus modifier strings like `ctrl+q`.

## How it works

Reads the OpenCode local SQLite session database in read-only mode, parses conversations into searchable text, builds a Telescope-owned sidecar index, and opens the selected session through the existing TUI route. Optional semantic search adds local embeddings and `sqlite-vec` vector retrieval on top of the same sidecar.

## Keywords

OpenCode plugin, OpenCode TUI, fuzzy finder, semantic search, vector search, embeddings, sqlite-vec, llama-server, conversation search, chat history search, AI coding session search, LLM history, local session search, Telescope-style picker.

![Demo animation](./assets/demo.gif)
