# Semantic Search Setup

opencode-telescope can search OpenCode chat history by meaning, not only by exact keywords. The default keyword/fuzzy search still works without extra setup. Semantic search turns on automatically when the local vector dependencies are ready.

## What It Adds

- Hybrid search across keyword FTS results and vector semantic matches.
- Vector-only results when a query is related by meaning but not exact wording.
- Local embeddings through a `llama-server` endpoint.
- A Telescope-owned sidecar index so OpenCode's source database stays read-only.

## Requirements

- `@bojackduy/opencode-telescope` installed in OpenCode.
- A local `llama-server` with an embedding model.
- `sqlite-vec`, provided by the package dependency or by `OPENCODE_TELESCOPE_SQLITE_VEC_EXT`.
- On macOS, an extension-capable SQLite library. Telescope tries Homebrew SQLite automatically, or you can set `OPENCODE_TELESCOPE_SQLITE_LIB`.

## Recommended Model

Use `nomic-ai/nomic-embed-text-v1.5-GGUF` for local embedding search.

```bash
mkdir -p "$HOME/.local/share/opencode-telescope/models"

huggingface-cli download \
  nomic-ai/nomic-embed-text-v1.5-GGUF \
  nomic-embed-text-v1.5.f16.gguf \
  --local-dir "$HOME/.local/share/opencode-telescope/models" \
  --local-dir-use-symlinks false
```

## Start The Embedding Server

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

Smoke test the server:

```bash
curl http://127.0.0.1:8081/health

curl http://127.0.0.1:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"search_query: find the auth caching discussion","model":"nomic-embed-text-v1.5","encoding_format":"float"}'
```

## Configure Telescope

Telescope defaults to `http://127.0.0.1:8081`, so most local setups only need the server running before opening OpenCode.

Optional environment variables:

```bash
OPENCODE_TELESCOPE_EMBED_BASE_URL=http://127.0.0.1:8081
OPENCODE_TELESCOPE_EMBED_MODEL=nomic-embed-text-v1.5
OPENCODE_TELESCOPE_HYBRID_ALPHA=0.45
OPENCODE_TELESCOPE_DISABLE_VECTOR=1
OPENCODE_TELESCOPE_SQLITE_LIB=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
OPENCODE_TELESCOPE_SQLITE_VEC_EXT=/path/to/vec0
```

`OPENCODE_TELESCOPE_HYBRID_ALPHA` controls the blend between keyword and vector ranking. `0` favors keyword search; `1` favors semantic vector search. The default is `0.45`.

Use `OPENCODE_TELESCOPE_DISABLE_VECTOR=1` to force keyword-only search.

## How It Works

1. Telescope reads OpenCode's SQLite session database in read-only mode.
2. It extracts searchable conversation documents into a sidecar index.
3. Keyword search uses local SQLite FTS.
4. Semantic search embeds documents with `search_document: ` and queries with `search_query: ` prefixes.
5. Vector rows are stored with `sqlite-vec` in the sidecar database.
6. Results are merged and ranked with hybrid keyword/vector scoring.

If the embedding server or vector extension is unavailable, Telescope keeps keyword search working and marks vector search unavailable internally.

## Troubleshooting

- If semantic results do not appear, confirm `curl http://127.0.0.1:8081/health` returns success.
- On macOS, install Homebrew SQLite if extension loading fails: `brew install sqlite`.
- Set `OPENCODE_TELESCOPE_SQLITE_LIB` if SQLite is installed somewhere other than Homebrew's default path.
- Set `OPENCODE_TELESCOPE_SQLITE_VEC_EXT` only when you need to load a specific `vec0` extension file.
- Set `OPENCODE_TELESCOPE_DISABLE_VECTOR=1` when you want fast keyword-only search or are debugging local embedding setup.
