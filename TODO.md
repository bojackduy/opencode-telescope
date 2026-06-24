# Tasks / Issues

## Performance
- Lagging when there are messy conversation/session history
  - Large session counts slow down fuzzy search (LIKE-based)
  - Preview expansion degrades with many messages per session

## Pagination
- Cursor resets to 0 on new query instead of continuing
  - Affects both result list (selector) and conversation preview
  - Need offset-based continuation instead of reset
- Follow-up: old pagination bug is only partially fixed
  - Preview no longer resets to the beginning, but can reset back to the previous/last position
  - User can get stuck at the preview boundary and cannot view tail content
  - Expected UX: selector anchors the match, then preview should scroll seamlessly through the whole conversation
  - Consider replacing bounded `before` / `after` preview range with stable upward/downward cursors

## Semantic Search
- Learn from `open-smart-history-search` repo
  - Look into embedding vectors for semantic search
  - Enhance beyond simple LIKE-based fuzzy matching

## OpenCode Truncation
- Chats exist in the database but opencode truncates them in TUI
  - Telescope finds match in DB but can't jump to it in rendered view
  - Need workaround for jumping to non-rendered messages

## Configurable Keybindings
- Support user-defined keybindings instead of hardcoded defaults
  - Use plugin-owned config file: `~/.config/opencode/opencode-telescope/config.json`
  - Configure global open key, navigation keys, preview scroll keys, open/close keys, and mode-switch keys
  - Keep defaults when config file is missing or partially invalid
