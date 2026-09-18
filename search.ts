// Re-exported types
export type {
  SearchResult,
  SearchRole,
  ConversationPreviewPart,
  ConversationPreviewPage,
  ConversationPreviewCursor,
  ToolState,
  SemanticConfig,
  SearchKind,
  KeywordIndexState,
  VectorState,
  SearchResponse,
  DocumentRow,
  ScoredRow,
  HybridSearchOptions,
} from "./search/types.ts"

export {
  parseSearchQuery,
  searchQueryHint,
  searchQueryLabel,
} from "./search/query.ts"

export type {
  ParsedSearchQuery,
  SearchQueryClause,
} from "./search/query.ts"

// Re-exported query functions
export {
  searchSessionMessages,
  searchSessionMessagesWithStatus,
  searchSourceFallbackWithStatus,
  recentSessionMessages,
  recentSessionMessagesWithStatus,
  loadConversationAround,
  loadConversationBefore,
  loadConversationAfter,
  performSearch,
  performSearchWithStatus,
  semanticSearchSessionMessages,
  semanticSearchSessionMessagesWithStatus,
  parseSemanticConfig,
  openSearchIndex,
  readKeywordIndexState,
  rebuildKeywordIndex,
  rebuildKeywordIndexForDbPath,
  syncKeywordIndexForDbPath,
  removeIndexedRowsForDbPath,
} from "./search/queries.ts"

// Re-exported text/snippet functions
export {
  rowToSearchResult,
  rowToVectorResult,
  makeSnippet,
  extractSearchText,
  ftsQuery,
  expandQuery,
  chunkTextForEmbedding,
  chunkRowForEmbedding,
  buildDocId,
  hashChunkContent,
  CHUNKER_VERSION,
  MAX_CHUNK_CHARS,
  CHUNK_OVERLAP_CHARS,
} from "./search/text.ts"

// Re-exported vector/blend functions
export {
  hybridBlend,
  rrfBlend,
  RRF_K,
  searchVector,
  buildVectorSearchPlan,
  isVectorReady,
  isVectorVersionStale,
  getEmbeddingVersion,
  collectStaleVectorChunks,
  upsertVectorChunkEmbeddings,
  removeVectorChunksForPart,
  removeVectorChunksForDocIds,
  syncVectorIndexForDbPath,
} from "./search/vector.ts"

// Re-exported path utilities
export {
  resolveDatabasePath,
  searchIndexPath,
} from "./search/db-path.ts"
