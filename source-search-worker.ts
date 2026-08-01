import { searchSourceFallbackWithStatus } from "./search"

let activeId = -1

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg.type !== "source-search") return

  activeId = msg.id
  try {
    const response = searchSourceFallbackWithStatus(msg.query, {
      limit: msg.limit,
      dbPath: msg.dbPath,
      directory: msg.directory,
      role: msg.role,
    })
    if (msg.id === activeId) {
      self.postMessage({ type: "source-result", id: msg.id, result: response.results, limit: msg.limit, keywordState: response.keywordState })
    }
  } catch (err) {
    if (msg.id === activeId) {
      self.postMessage({ type: "source-error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
