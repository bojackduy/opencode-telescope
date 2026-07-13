// Re-exported types
export type {
  SearchResult,
  SearchRole,
  ConversationPreviewPart,
  ConversationPreviewPage,
  ConversationPreviewCursor,
  ToolState,
  SemanticConfig,
  VectorState,
  DocumentRow,
  ScoredRow,
  HybridSearchOptions,
} from "./search/types.ts"

// Re-exported query functions
export {
  searchSessionMessages,
  recentSessionMessages,
  loadConversationAround,
  loadConversationBefore,
  loadConversationAfter,
  performSearch,
  semanticSearchSessionMessages,
  parseSemanticConfig,
} from "./search/queries.ts"

// Re-exported text/snippet functions
export {
  rowToSearchResult,
  rowToVectorResult,
  makeSnippet,
  extractSearchText,
  ftsQuery,
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
