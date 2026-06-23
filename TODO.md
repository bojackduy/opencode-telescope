# Tasks / Issues

## Performance
- Lagging when there are messy conversation/session history
  - Large session counts slow down fuzzy search (LIKE-based)
  - Preview expansion degrades with many messages per session

## Pagination
- Cursor resets to 0 on new query instead of continuing
  - Affects both result list (selector) and conversation preview
  - Need offset-based continuation instead of reset

## Semantic Search
- Learn from `open-smart-history-search` repo
  - Look into embedding vectors for semantic search
  - Enhance beyond simple LIKE-based fuzzy matching

## OpenCode Truncation
- Chats exist in the database but opencode truncates them in TUI
  - Telescope finds match in DB but can't jump to it in rendered view
  - Need workaround for jumping to non-rendered messages
