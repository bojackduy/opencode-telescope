import { streamSearchBuckets } from "./search/streaming"

let activeID = -1

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  if (msg.type === "cancel-stream") {
    if (activeID === msg.id) activeID = -1
    return
  }
  if (msg.type !== "stream-search") return

  activeID = msg.id
  const generator = streamSearchBuckets(msg.dbPath, msg.query, {
    directory: msg.directory,
    role: msg.role,
    limit: msg.limit,
  })

  try {
    for (const batch of generator) {
      if (activeID !== msg.id) return
      self.postMessage({ type: "stream-batch", id: msg.id, ...batch })
      if (batch.isComplete) return
      await Bun.sleep(0)
    }
  } catch (err) {
    if (activeID === msg.id) {
      self.postMessage({ type: "stream-error", id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    generator.return(undefined)
  }
}
