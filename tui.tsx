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

  const command = "opencode.telescope.sessions"
  const open = () => {
    api.ui.dialog.replace(() => <Telescope api={api} onClose={() => api.ui.dialog.clear()} />)
    api.ui.dialog.setSize("xlarge")
  }

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
    bindings: [{ key: "<leader>f", desc: "Search conversations", group: "Search", cmd: open }],
  })

  api.lifecycle.onDispose(() => {
    unregisterKeymap()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
