import { loadConversationAfter, loadConversationAround, loadConversationBefore } from "./search"

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg.type !== "preview-around" && msg.type !== "preview-before" && msg.type !== "preview-after") return

  try {
    const page = msg.type === "preview-around"
      ? loadConversationAround(msg.result, { before: msg.before, after: msg.after, dbPath: msg.dbPath })
      : msg.type === "preview-before"
        ? loadConversationBefore(msg.result, msg.cursor, { limit: msg.limit, dbPath: msg.dbPath })
        : loadConversationAfter(msg.result, msg.cursor, { limit: msg.limit, dbPath: msg.dbPath })
    self.postMessage({ type: "preview-result", id: msg.id, itemID: msg.result.id, page })
  } catch (err) {
    self.postMessage({ type: "preview-error", id: msg.id, itemID: msg.result.id, error: err instanceof Error ? err.message : String(err) })
  }
}
