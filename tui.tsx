/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Telescope } from "./telescope.tsx"

const id = "opencode-telescope"

const enabled = (options: unknown) => {
  if (!options || typeof options !== "object" || Array.isArray(options)) return true
  const value = (options as Record<string, unknown>).enabled
  return typeof value === "boolean" ? value : true
}

const tui: TuiPlugin = async (api: TuiPluginApi, options: unknown) => {
  if (!enabled(options)) return

  const open = () => {
    api.ui.dialog.replace(() => <Telescope api={api} onClose={() => api.ui.dialog.clear()} />)
    api.ui.dialog.setSize("xlarge")
  }

  const unregister = api.command?.register(() => [
    {
      title: "Telescope Sessions",
      value: "opencode.telescope.sessions",
      category: "Search",
      slash: { name: "telescope", aliases: ["sessions-grep", "session-grep"] },
      onSelect() {
        open()
      },
    },
  ])

  api.lifecycle.onDispose(() => unregister?.())
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
