import { performSearch, recentSessionMessages } from "./search"

let activeId = -1

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  if (msg.type === "search" || msg.type === "recent") {
    activeId = msg.id
    try {
      const batch = msg.type === "search"
        ? await performSearch(msg.query, {
            limit: msg.limit,
            offset: msg.offset ?? 0,
            dbPath: msg.dbPath,
            directory: msg.directory,
            role: msg.role,
          })
        : recentSessionMessages({
            limit: msg.limit,
            offset: msg.offset ?? 0,
            dbPath: msg.dbPath,
            directory: msg.directory,
            role: msg.role,
          })
      if (msg.id === activeId) {
        self.postMessage({ type: "search-result", id: msg.id, result: batch, limit: msg.limit })
      }
    } catch (err) {
      if (msg.id === activeId) {
        self.postMessage({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}
