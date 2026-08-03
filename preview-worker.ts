import { loadConversationAround } from "./search"

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg.type !== "preview-around") return

  try {
    const page = loadConversationAround(msg.result, {
      before: msg.before,
      after: msg.after,
      dbPath: msg.dbPath,
    })
    self.postMessage({ type: "preview-result", id: msg.id, itemID: msg.result.id, page })
  } catch (err) {
    self.postMessage({ type: "preview-error", id: msg.id, itemID: msg.result.id, error: err instanceof Error ? err.message : String(err) })
  }
}
