/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Telescope } from "./telescope.tsx"
import { debug } from "./ui/debug.ts"
import { loadTelescopeConfig } from "./ui/config.ts"

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
    unregisterKeymap()
  })
  debug.log("plugin:setup:done")
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
