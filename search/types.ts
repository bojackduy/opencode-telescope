export type SearchResult = {
  id: string
  messageID: string
  sessionID: string
  sessionTitle: string
  directory: string
  role: "user" | "assistant"
  kind?: SearchKind
  partType: "text" | "reasoning" | "tool"
  tool?: string
  timeCreated: number
  snippet: string
  matchStart: number
  matchEnd: number
  before: string
  match: string
  after: string
  excerpt: string
  previewBefore: string
  previewMatch: string
  previewAfter: string
  previewMode: "markdown" | "text"
  previewHighlight: boolean
  text: string
  isVectorMatch: boolean
  semanticScore: number
}

export type SearchRole = "user" | "assistant"

export type SearchKind = SearchRole | "thought" | "patch"

export type ConversationPreviewPart = {
  id: string
  messageID: string
  sessionID: string
  role: "user" | "assistant"
  type: "text" | "reasoning" | "tool"
  timeCreated: number
  text: string
  tool?: string
  state?: ToolState
  target: boolean
}

export type ConversationPreviewPage = {
  parts: ConversationPreviewPart[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export type ConversationPreviewCursor = {
  id: string
  timeCreated: number
}

export type ToolState = {
  status: "pending" | "running" | "completed" | "error"
  input?: unknown
  metadata?: unknown
  output?: string
  error?: string
}

export type SemanticConfig = {
  embedBaseUrl: string
  embedModel?: string
  disableVector: boolean
  sqliteLibPath?: string
  sqliteVecExtension?: string
  hybridAlpha: number
  documentPrefix: string
  queryPrefix: string
}

export type KeywordIndexState = "ready" | "stale" | "missing" | "empty" | "indexing" | "error"

export type VectorState = "enabled" | "disabled" | "unavailable" | "stale" | "indexing"

export type SearchResponse = {
  results: SearchResult[]
  keywordState: KeywordIndexState
  vectorState?: VectorState
  stale: boolean
}

export type ScoredRow = Row & {
  score: number
  keywordScore: number
  vectorScore: number
}

export type HybridSearchOptions = {
  limit?: number
  offset?: number
  directory?: string
  role?: SearchRole
  dbPath?: string
}

export type DocumentRow = {
  doc_id: string
  part_id: string
  message_id: string
  session_id: string
  session_title: string
  directory: string
  role: string
  kind: SearchKind
  part_type: string
  tool: string | null
  time_created: number
  chunk_index: number
  text: string
  source_hash: string
  extractor_version: string
}

export type Row = {
  id: string
  message_id: string
  session_id: string
  session_title: string | null
  directory: string
  role: SearchRole
  kind?: SearchKind
  part_type?: SearchResult["partType"]
  tool?: string | null
  time_created: number
  text: string
}

export type IndexSourceRow = Omit<Row, "text"> & {
  data: string
}

export type ConversationRow = {
  id: string
  message_id: string
  session_id: string
  role: SearchRole
  type: "text" | "reasoning" | "tool"
  time_created: number
  data: string
}
