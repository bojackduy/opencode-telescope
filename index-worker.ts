import { rebuildKeywordIndexForDbPath } from "./search"

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg.type !== "rebuild-index") return

  try {
    self.postMessage({ type: "index-started", id: msg.id, dbPath: msg.dbPath })
    rebuildKeywordIndexForDbPath(msg.dbPath)
    self.postMessage({ type: "index-done", id: msg.id, dbPath: msg.dbPath })
  } catch (err) {
    self.postMessage({
      type: "index-error",
      id: msg.id,
      dbPath: msg.dbPath,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
