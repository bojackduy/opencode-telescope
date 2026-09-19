/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiV2 } from "@opencode/plugin/tui"
import { Telescope } from "./telescope.tsx"
import { resolveDatabasePath } from "./search.ts"
import { debug } from "./ui/debug.ts"
import { loadTelescopeConfig } from "./ui/config.ts"
import { disposeWorkerService, prewarmSearchWorker, removeFromIndex, requestIndexSync } from "./worker-service.ts"

const id = "opencode-telescope"

const enabled = (options: unknown) => {
  if (!options || typeof options !== "object" || Array.isArray(options)) return true
  const value = (options as Record<string, unknown>).enabled
  return typeof value === "boolean" ? value : true
}

const tui: TuiPlugin = async (api: TuiPluginApi, options: unknown) => {
  debug.log("plugin:setup:start")
  if (!enabled(options)) return

  const config = loadTelescopeConfig()
  const dbPath = resolveDatabasePath()
  const directory = api.state.path.directory
  prewarmSearchWorker({ dbPath, directory })
  let indexTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleIndexSync = (delay = 500) => {
    if (indexTimer) clearTimeout(indexTimer)
    indexTimer = setTimeout(() => {
      indexTimer = undefined
      requestIndexSync(dbPath)
    }, delay)
  }
  scheduleIndexSync(1_000)
  const indexEvents = [
    "session.updated",
    "message.updated",
    "message.part.updated",
    "session.compacted",
  ] as const
  const unregisterIndexEvents = indexEvents.map((type) => api.event.on(type, () => scheduleIndexSync()))
  unregisterIndexEvents.push(
    api.event.on("message.part.removed", (event) => removeFromIndex(dbPath, { partID: event.properties.partID })),
    api.event.on("message.removed", (event) => removeFromIndex(dbPath, { messageID: event.properties.messageID })),
    api.event.on("session.deleted", (event) => removeFromIndex(dbPath, { sessionID: event.properties.sessionID })),
  )
  const command = "opencode.telescope.sessions"
  const open = () => {
    debug.log("plugin:dialog:open:start")
    api.ui.dialog.replace(() => <Telescope api={api} config={config} onClose={() => api.ui.dialog.clear()} />)
    api.ui.dialog.setSize("xlarge")
    debug.log("plugin:dialog:open:done")
  }

  debug.log("plugin:setup:register-keymap")
  const unregisterKeymap = api.keymap.registerLayer({
    commands: [
      {
        name: command,
        title: "Telescope Sessions",
        category: "Search",
        namespace: "palette",
        slashName: "telescope",
        run: open,
      },
    ],
    bindings: [{ key: config.openKey, desc: "Search conversations", group: "Search", cmd: open }],
  })

  api.lifecycle.onDispose(() => {
    if (indexTimer) clearTimeout(indexTimer)
    for (const unregister of unregisterIndexEvents) unregister()
    disposeWorkerService()
    unregisterKeymap()
  })
  debug.log("plugin:setup:done")
}

// (dual `{ id, tui, setup }` export lives at the end of this file, after `v2`)


// ─── V2 (opencode v2 core) ───────────────────────────────────────────────────
// The v2 TUI loader validates `default` as `{ id: nonEmptyString, setup: fn }`
// and rejects anything else with "Invalid V2 TUI plugin module". The v1 TUI
// loader (`readV1Plugin`, kind=tui) reads `.tui` and ignores extra keys, so a
// single `{ id, tui, setup }` object loads on both cores.
//
// v2 API differences handled here (telescope.tsx is untouched — it talks to a
// facade cast as the v1 `TuiPluginApi`):
// - events: v2 has no `message.*` / `session.updated` / `session.compacted`.
//   `session.idle` fires when a session settles, which is the correct indexing
//   trigger; `session.created` / `session.deleted` / `session.compaction.ended`
//   cover the rest. Surgical per-part removals are gone, so any event just
//   re-syncs (except `session.deleted`, which also drops that session's rows).
//   Payloads moved from `event.properties.*` to `event.data.*`.
// - dialog: `replace` → `show`, `setSize` → `set({ size })`; v2 `Dialog` has no
//   `open` getter, so openness is tracked locally (we own show/clear).
// - keymap: `{ name, category, namespace: "palette", slashName }` commands +
//   `{ key, cmd }` bindings → `{ id, group, palette: true, slash: { name } }`
//   commands with `bind: openKey`, activated via layer `bindings: [id]`.
// - theme: v2 `ResolvedTheme` is nested (`text.default`, `syntax.comment`,
//   `markdown.heading`, …) vs v1's flat `TuiThemeCurrent`; adapted below.
//   `primary`/`accent` have no v2 counterpart and fall back to `text.default`.
// - messages: v2 items carry `type` ("user"/"assistant") instead of `role` and
//   no `parentID`, so the jump-to-turn heuristic (needs parent links) stays
//   disabled on v2 while exact target matching works as before.
function adaptThemeV2(theme: TuiV2.Context["theme"]): TuiThemeCurrent {
  return {
    text: theme.text.default,
    textMuted: theme.text.subdued,
    primary: theme.text.default,
    accent: theme.text.default,
    success: theme.text.feedback.success.default,
    warning: theme.text.feedback.warning.default,
    error: theme.text.feedback.error.default,
    info: theme.text.feedback.info.default,
    background: theme.background.default,
    backgroundPanel: theme.background.surface.overlay,
    backgroundElement: theme.background.surface.offset,
    diffAdded: theme.diff.text.added,
    diffRemoved: theme.diff.text.removed,
    diffContext: theme.diff.text.context,
    diffAddedBg: theme.diff.background.added,
    diffRemovedBg: theme.diff.background.removed,
    diffContextBg: theme.diff.background.context,
    diffHighlightAdded: theme.diff.highlight.added,
    diffHighlightRemoved: theme.diff.highlight.removed,
    diffLineNumber: theme.diff.lineNumber.text,
    diffAddedLineNumberBg: theme.diff.lineNumber.background.added,
    diffRemovedLineNumberBg: theme.diff.lineNumber.background.removed,
    syntaxComment: theme.syntax.comment,
    syntaxKeyword: theme.syntax.keyword,
    syntaxFunction: theme.syntax.function,
    syntaxVariable: theme.syntax.variable,
    syntaxString: theme.syntax.string,
    syntaxNumber: theme.syntax.number,
    syntaxType: theme.syntax.type,
    syntaxOperator: theme.syntax.operator,
    syntaxPunctuation: theme.syntax.punctuation,
    markdownText: theme.markdown.text,
    markdownHeading: theme.markdown.heading,
    markdownLink: theme.markdown.link,
    markdownLinkText: theme.markdown.linkText,
    markdownCode: theme.markdown.code,
    markdownBlockQuote: theme.markdown.blockQuote,
    markdownEmph: theme.markdown.emphasis,
    markdownStrong: theme.markdown.strong,
    markdownListItem: theme.markdown.listItem,
  } as TuiThemeCurrent
}

// `define()` in `@opencode/plugin` is the identity function, so the v2 side is
// a plain object literal on purpose: no runtime import of `@opencode/*`
// (which lives in devDependencies for types only), keeping the TUI entry's
// runtime deps exactly as before (peers provided by the host).
const v2setup: TuiV2.Definition["setup"] = (ctx) => {
    debug.log("plugin:setup:start:v2")
    if (!enabled(ctx.options)) return

    const config = loadTelescopeConfig()
    const dbPath = resolveDatabasePath()
    const directory = ctx.location?.directory ?? ctx.data.location.default().directory
    prewarmSearchWorker({ dbPath, directory })
    let indexTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleIndexSync = (delay = 500) => {
      if (indexTimer) clearTimeout(indexTimer)
      indexTimer = setTimeout(() => {
        indexTimer = undefined
        requestIndexSync(dbPath)
      }, delay)
    }
    scheduleIndexSync(1_000)
    const unsubs = [
      ctx.data.on("session.idle", () => scheduleIndexSync()),
      ctx.data.on("session.created", () => scheduleIndexSync()),
      ctx.data.on("session.compaction.ended", () => scheduleIndexSync()),
      ctx.data.on("session.deleted", (event) => {
        removeFromIndex(dbPath, { sessionID: event.data.sessionID })
        scheduleIndexSync()
      }),
    ]

    let dialogOpen = false
    const closeDialog = () => {
      dialogOpen = false
      ctx.ui.dialog.clear()
    }
    // Facade: telescope.tsx was written against the v1 TuiPluginApi. Only the
    // calls it actually makes are mapped here; everything else is untouched.
    const facade = {
      theme: {
        get current() {
          return adaptThemeV2(ctx.theme)
        },
      },
      state: {
        path: { directory },
        session: {
          messages: (sessionID: string) =>
            ctx.data.session.message.list(sessionID).map((m) => ({ id: m.id, role: m.type, parentID: undefined })),
        },
      },
      client: {
        session: {
          messages: async (input: { sessionID: string; limit?: number }) => {
            const res = await ctx.client.message.list({ sessionID: input.sessionID, limit: input.limit ?? 100 })
            return { data: res.data.map((m) => ({ info: m })) }
          },
        },
      },
      renderer: ctx.renderer,
      ui: {
        dialog: {
          clear: closeDialog,
          get open() {
            return dialogOpen
          },
        },
        toast: (t: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string; duration?: number }) =>
          ctx.ui.toast.show(t),
      },
      route: {
        get current() {
          const r = ctx.ui.router.current()
          return r.type === "session" ? { name: "session", params: { sessionID: r.sessionID } } : { name: r.type }
        },
        navigate: (name: string, params?: Record<string, unknown>) => {
          if (name === "session") ctx.ui.router.navigate({ type: "session", sessionID: params?.sessionID as string })
        },
      },
    } as unknown as TuiPluginApi

    const command = "opencode.telescope.sessions"
    const open = () => {
      debug.log("plugin:dialog:open:start")
      dialogOpen = true
      ctx.ui.dialog.show(() => <Telescope api={facade} config={config} onClose={closeDialog} />, () => {
        dialogOpen = false
      })
      ctx.ui.dialog.set({ size: "xlarge" })
      debug.log("plugin:dialog:open:done")
    }

    debug.log("plugin:setup:register-keymap")
    // NOTE: ctx.keymap.layer() must run inside a component — the host
    // resolves the layer against the ambient Keymap provider, so calling it
    // here in setup() throws "Keymap.Provider is missing". Claim the always-
    // mounted "app" slot with a null-render component as the mount point.
    let layerRegistered = false
    const unclaimSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        if (!layerRegistered) {
          layerRegistered = true
          ctx.keymap.layer(() => ({
            commands: [
              {
                id: command,
                title: "Telescope Sessions",
                group: "Search",
                palette: true,
                slash: { name: "telescope" },
                bind: config.openKey,
                run: open,
              },
            ],
            bindings: [command],
          }))
        }
        return null
      },
    })

    debug.log("plugin:setup:done:v2")
    return () => {
      if (indexTimer) clearTimeout(indexTimer)
      for (const un of unsubs) un()
      unclaimSlot()
      disposeWorkerService()
    }
  }

const plugin = {
  id,
  tui,
  setup: v2setup,
} satisfies TuiPluginModule & { id: string; setup: typeof v2setup }

// Dual export is validated both ways (see comment above the v2 block).
export default plugin
