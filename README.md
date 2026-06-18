# opencode-telescope

Telescope-style session conversation search for the OpenCode TUI.

This plugin searches OpenCode's local SQLite session database directly in read-only mode, then opens the selected session with the existing TUI route.

## Usage

Add the plugin to your OpenCode `tui.json`:

```jsonc
{
  "plugin": ["../opencode-telescope"]
}
```

The path is resolved relative to `tui.json`. If your config is somewhere else, use the matching relative path or an absolute `file://` URL.

Then run `/telescope` in OpenCode.
