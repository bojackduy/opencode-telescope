import { performSearchWithStatus, recentSessionMessagesWithStatus } from "./search"
import { streamSearchBuckets } from "./search/streaming"

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data
  if (msg.type !== "search" && msg.type !== "recent") return

  const id = msg.id
  let ftsStarted = false
  let ftsDone = false
  let streamingDone = false
  let streamingResults: any[] | undefined

  const postStreamBatch = (batch: ReturnType<typeof streamSearchBuckets> extends Generator<infer T> ? T : never) => {
    if (msg.id !== id) return
    self.postMessage({ type: "stream-batch", id, results: batch.results, bucketLabel: batch.bucketLabel, bucketIndex: batch.bucketIndex, isComplete: batch.isComplete })
    if (batch.isComplete) {
      streamingDone = true
      streamingResults = batch.results
      // If FTS is already done, no further action needed.
      // If FTS hasn't started yet, let it run as upgrade.
    }
  }

  const runStreaming = () => {
    try {
      const gen = streamSearchBuckets(msg.dbPath, msg.query, {
        directory: msg.directory,
        role: msg.role,
        limit: msg.limit,
      })
      for (const batch of gen) {
        if (msg.id !== id) return
        postStreamBatch(batch)
        if (batch.isComplete) return
      }
    } catch (err) {
      if (msg.id !== id) {
        self.postMessage({ type: "stream-error", id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // Start streaming immediately - this hits the source DB via indexes, not the sidecar
  runStreaming()

  // Run FTS sidecar search in parallel for authoritative ranked results
  try {
    ftsStarted = true
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
    ftsDone = true

    // FTS is authoritative. Post regardless of streaming state.
    if (msg.id === id) {
      self.postMessage({ type: "search-result", id, result: response.results, limit: msg.limit, keywordState: response.keywordState, vectorState: response.vectorState, stale: response.stale })
    }
  } catch (err) {
    if (msg.id === id) {
      self.postMessage({ type: "error", id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
