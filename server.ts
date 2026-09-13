import type { Plugin } from "@opencode-ai/plugin"
import { define } from "@opencode-ai/plugin/v2/promise"

const id = "opencode-telescope"

// V1 server hook: telescope is TUI-only, so the server side is a no-op.
// It exists so the v1 server loader finds a valid "./server" entry instead
// of reporting "missing entrypoint", and so v2's `import.meta.resolve(name)`
// (which resolves ".") lands on a module v2 can decode.
const server: Plugin = async () => ({})

const v2 = define({
  id,
  async setup() {
    // No-op: search indexing and UI live in the TUI entry (tui.tsx).
    // This keeps the v2 external loader (`config/plugin/external.ts`,
    // which decodes default as { id, effect } | { id, setup }) happy
    // while the actual UI loads via the TUI runtime ("./tui").
  },
})

// Dual export: v1 loader reads `.server`, v2 loader reads `.setup`.
// `readV1Plugin` ignores the extra `setup` key; v2's Schema decodes
// `{ id, setup }` and ignores the extra `server` key.
const plugin = {
  id,
  server,
  setup: v2.setup,
}

export default plugin
