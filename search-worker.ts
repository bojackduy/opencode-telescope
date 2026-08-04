import { performSearchWithStatus, recentSessionMessagesWithStatus } from "./search"

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  if (msg.type === "search" || msg.type === "recent") {
    try {
      const response = msg.type === "search"
        ? await performSearchWithStatus(msg.query, {
            limit: msg.limit,
            offset: msg.offset ?? 0,
            dbPath: msg.dbPath,
            directory: msg.directory,
            role: msg.role,
          })
        : recentSessionMessagesWithStatus({
            limit: msg.limit,
            offset: msg.offset ?? 0,
            dbPath: msg.dbPath,
            directory: msg.directory,
            role: msg.role,
          })
      self.postMessage({ type: "search-result", id: msg.id, result: response.results, limit: msg.limit, keywordState: response.keywordState, vectorState: response.vectorState, stale: response.stale })
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
