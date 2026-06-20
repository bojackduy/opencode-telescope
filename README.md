# opencode-telescope

Telescope-style session conversation search for the OpenCode TUI.

This plugin searches OpenCode's local SQLite session database directly in read-only mode, then opens the selected session with the existing TUI route.

## Installation

Add the plugin to your `opencode.json`:

```jsonc
{
  "plugin": ["@Duyyy123/opencode-telescope"],
}
```

> To use it from a local clone:
>
> ```jsonc
> "plugin": ["./path/to/opencode-telescope"]
> ```

## Usage

Run `/telescope` or shortcut `<lead>+f` in OpenCode to search and jump to any session.
