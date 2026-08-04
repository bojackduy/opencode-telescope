import type { ConversationPreviewCursor, ConversationPreviewPage, SearchResponse, SearchResult, SearchRole } from "./search.ts"

type SearchInput = {
  query: string
  limit: number
  offset?: number
  directory?: string
  role?: SearchRole
  dbPath: string
}

type PreviewInput = {
  operation: "around" | "before" | "after"
  result: SearchResult
  cursor?: ConversationPreviewCursor
  before?: number
  after?: number
  limit?: number
  dbPath: string
}

type IndexEvent = { type: "index-started" | "index-done" | "index-error" | "index-removed" | "index-remove-error"; dbPath: string; error?: string }

let searchWorker: Worker | undefined
let previewWorker: Worker | undefined
let indexWorker: Worker | undefined
let requestID = 0
const searchRequests = new Map<number, { resolve: (value: SearchResponse) => void; reject: (error: Error) => void }>()
const previewRequests = new Map<number, { resolve: (value: ConversationPreviewPage) => void; reject: (error: Error) => void }>()
const indexListeners = new Set<(event: IndexEvent) => void>()
const activeIndexJobs = new Set<string>()
const pendingIndexJobs = new Set<string>()

export function searchInWorker(input: SearchInput): Promise<SearchResponse> {
  const worker = ensureSearchWorker()
  const id = ++requestID
  return new Promise((resolve, reject) => {
    searchRequests.set(id, { resolve, reject })
    worker.postMessage({
      type: input.query ? "search" : "recent",
      id,
      query: input.query,
      limit: input.limit,
      offset: input.offset ?? 0,
      directory: input.directory,
      role: input.role,
      dbPath: input.dbPath,
    })
  })
}

export function previewInWorker(input: PreviewInput): Promise<ConversationPreviewPage> {
  const worker = ensurePreviewWorker()
  const id = ++requestID
  return new Promise((resolve, reject) => {
    previewRequests.set(id, { resolve, reject })
    worker.postMessage({ type: `preview-${input.operation}`, id, ...input })
  })
}

export function prewarmSearchWorker(input: Omit<SearchInput, "query" | "limit">) {
  void searchInWorker({ ...input, query: "", limit: 1 }).catch(() => {})
}

export function requestIndexSync(dbPath: string) {
  if (activeIndexJobs.has(dbPath)) {
    pendingIndexJobs.add(dbPath)
    return
  }
  activeIndexJobs.add(dbPath)
  ensureIndexWorker().postMessage({ type: "sync-index", id: ++requestID, dbPath })
}

export function removeFromIndex(dbPath: string, target: { partID?: string; messageID?: string; sessionID?: string }) {
  ensureIndexWorker().postMessage({ type: "remove-index", id: ++requestID, dbPath, target })
}

export function isIndexSyncActive(dbPath: string) {
  return activeIndexJobs.has(dbPath)
}

export function subscribeIndexEvents(listener: (event: IndexEvent) => void) {
  indexListeners.add(listener)
  return () => indexListeners.delete(listener)
}

export function disposeWorkerService() {
  const error = new Error("Telescope worker service disposed")
  for (const request of searchRequests.values()) request.reject(error)
  for (const request of previewRequests.values()) request.reject(error)
  searchRequests.clear()
  previewRequests.clear()
  activeIndexJobs.clear()
  pendingIndexJobs.clear()
  indexListeners.clear()
  searchWorker?.terminate()
  previewWorker?.terminate()
  indexWorker?.terminate()
  searchWorker = undefined
  previewWorker = undefined
  indexWorker = undefined
}

function ensureSearchWorker() {
  if (searchWorker) return searchWorker
  searchWorker = new Worker(new URL("./search-worker.ts", import.meta.url))
  searchWorker.onmessage = (event: MessageEvent) => {
    const msg = event.data
    const request = searchRequests.get(msg.id)
    if (!request) return
    searchRequests.delete(msg.id)
    if (msg.type === "error") {
      request.reject(new Error(msg.error))
      return
    }
    request.resolve({
      results: msg.result,
      keywordState: msg.keywordState,
      vectorState: msg.vectorState,
      stale: Boolean(msg.stale),
    })
  }
  searchWorker.onerror = (event) => {
    rejectRequests(searchRequests, event.message)
    searchWorker?.terminate()
    searchWorker = undefined
  }
  return searchWorker
}

function ensurePreviewWorker() {
  if (previewWorker) return previewWorker
  previewWorker = new Worker(new URL("./preview-worker.ts", import.meta.url))
  previewWorker.onmessage = (event: MessageEvent) => {
    const msg = event.data
    const request = previewRequests.get(msg.id)
    if (!request) return
    previewRequests.delete(msg.id)
    if (msg.type === "preview-error") {
      request.reject(new Error(msg.error))
      return
    }
    request.resolve(msg.page)
  }
  previewWorker.onerror = (event) => {
    rejectRequests(previewRequests, event.message)
    previewWorker?.terminate()
    previewWorker = undefined
  }
  return previewWorker
}

function ensureIndexWorker() {
  if (indexWorker) return indexWorker
  indexWorker = new Worker(new URL("./index-worker.ts", import.meta.url))
  indexWorker.onmessage = (event: MessageEvent) => {
    const msg = event.data as IndexEvent
    if (msg.type === "index-done" || msg.type === "index-error") activeIndexJobs.delete(msg.dbPath)
    for (const listener of indexListeners) listener(msg)
    if (msg.type === "index-done" && pendingIndexJobs.delete(msg.dbPath)) requestIndexSync(msg.dbPath)
  }
  indexWorker.onerror = (event) => {
    const jobs = [...activeIndexJobs]
    activeIndexJobs.clear()
    pendingIndexJobs.clear()
    for (const dbPath of jobs) {
      for (const listener of indexListeners) listener({ type: "index-error", dbPath, error: event.message })
    }
    indexWorker?.terminate()
    indexWorker = undefined
  }
  return indexWorker
}

function rejectRequests<T>(requests: Map<number, { reject: (error: Error) => void } & T>, message: string) {
  const error = new Error(message || "Worker failed")
  for (const request of requests.values()) request.reject(error)
  requests.clear()
}
