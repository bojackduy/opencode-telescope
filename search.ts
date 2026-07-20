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
  searchQueryLabel,
} from "./search/query.ts"

export type {
  ParsedSearchQuery,
} from "./search/query.ts"

// Re-exported query functions
export {
  searchSessionMessages,
  searchSessionMessagesWithStatus,
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
} from "./search/queries.ts"

// Re-exported text/snippet functions
export {
  rowToSearchResult,
  rowToVectorResult,
  makeSnippet,
  extractSearchText,
  ftsQuery,
  expandQuery,
} from "./search/text.ts"

// Re-exported vector/blend functions
export {
  hybridBlend,
} from "./search/vector.ts"

// Re-exported path utilities
export {
  resolveDatabasePath,
  searchIndexPath,
} from "./search/db-path.ts"
