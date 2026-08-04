import { removeIndexedRowsForDbPath, syncKeywordIndexForDbPath } from "./search"

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  if (msg.type === "remove-index") {
    try {
      removeIndexedRowsForDbPath(msg.dbPath, msg.target)
      self.postMessage({ type: "index-removed", id: msg.id, dbPath: msg.dbPath })
    } catch (err) {
      self.postMessage({ type: "index-remove-error", id: msg.id, dbPath: msg.dbPath, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (msg.type !== "sync-index") return

  try {
    self.postMessage({ type: "index-started", id: msg.id, dbPath: msg.dbPath })
    await syncKeywordIndexForDbPath(msg.dbPath)
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
