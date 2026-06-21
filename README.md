# opencode-telescope

Fuzzy search across all your OpenCode conversations — grep through session history, find code snippets, and jump to any chat instantly.

> Inspired by [telescope.nvim](https://github.com/nvim-telescope/telescope.nvim) — a fuzzy finder for your conversation history.

## Use cases

- **"I know I discussed this somewhere"** — grep all your sessions by keyword
- **"Find that code snippet"** — search for code you saw in a past LLM response
- **"Revisit a decision"** — find the conversation where you chose approach X
- **"Session journal"** — browse your entire conversation history like a timeline

## Features

- **Fuzzy grep** — search across all session messages by text
- **Live preview** — preview the matched conversation result before opening
- **Find & jump** — select any result and jump straight to that session
- **Neovim Telescope-style UX** — familiar `<leader>f` keybind and `/telescope` command

## Installation

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

| Action | Key / Command |
|--------|--------------|
| Open search | `<leader>f` or `/telescope` |
| Type to filter | Fuzzy match against conversation text |
| Navigate results | `↑` / `↓` or `Ctrl+j` / `Ctrl+k` |
| Preview | Select a result to see the conversation preview |
| Open | Press `Enter` to jump to the selected session |

## How it works

Reads the OpenCode local SQLite session database in read-only mode, parses conversations into searchable text, and opens the selected session through the existing TUI route.
