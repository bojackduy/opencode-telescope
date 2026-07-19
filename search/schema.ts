import { Database } from "bun:sqlite"

export const SEARCH_INDEX_VERSION = "7"
export const DOCUMENT_EXTRACTOR_VERSION = "1"

export function migrateSearchIndex(db: Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS index_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document(
      rowid INTEGER PRIMARY KEY,
      doc_id TEXT UNIQUE NOT NULL,
      part_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL,
      directory TEXT NOT NULL,
      role TEXT NOT NULL,
      part_type TEXT NOT NULL,
      tool TEXT,
      time_created INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
      id UNINDEXED,
      message_id UNINDEXED,
      session_id UNINDEXED,
      session_title,
      directory UNINDEXED,
      role UNINDEXED,
      part_type UNINDEXED,
      tool UNINDEXED,
      time_created UNINDEXED,
      text,
      tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS document_index(
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL,
      directory TEXT NOT NULL,
      role TEXT NOT NULL,
      part_type TEXT NOT NULL,
      tool TEXT,
      time_created INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_index_recent_idx
      ON document_index(directory, role, time_created DESC);
    CREATE INDEX IF NOT EXISTS document_index_recent_text_idx
      ON document_index(directory, role, part_type, time_created DESC);
    CREATE INDEX IF NOT EXISTS document_index_time_idx
      ON document_index(time_created DESC);
  `)

  const columns = db.query<{ name: string }, []>("PRAGMA table_info(document_fts)").all().map((column) => column.name)
  if (!columns.includes("part_type") || !columns.includes("tool")) {
    db.exec("DROP TABLE document_fts")
    db.exec(`
      CREATE VIRTUAL TABLE document_fts USING fts5(
        id UNINDEXED,
        message_id UNINDEXED,
        session_id UNINDEXED,
        session_title,
        directory UNINDEXED,
        role UNINDEXED,
        part_type UNINDEXED,
        tool UNINDEXED,
        time_created UNINDEXED,
        text,
        tokenize='unicode61'
      );
    `)
  }

  const indexColumns = db.query<{ name: string }, []>("PRAGMA table_info(document_index)").all().map((column) => column.name)
  if (!["part_type", "tool", "time_created", "text"].every((name) => indexColumns.includes(name))) {
    db.exec("DROP TABLE IF EXISTS document_index")
    db.exec(`
      CREATE TABLE document_index(
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_title TEXT NOT NULL,
        directory TEXT NOT NULL,
        role TEXT NOT NULL,
        part_type TEXT NOT NULL,
        tool TEXT,
        time_created INTEGER NOT NULL,
        text TEXT NOT NULL
      );
    `)
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS document_index_recent_idx
      ON document_index(directory, role, time_created DESC);
    CREATE INDEX IF NOT EXISTS document_index_recent_text_idx
      ON document_index(directory, role, part_type, time_created DESC);
    CREATE INDEX IF NOT EXISTS document_index_time_idx
      ON document_index(time_created DESC);
  `)
}

export function getMeta(db: Database, key: string) {
  return db.query<{ value: string }, [string]>("SELECT value FROM index_meta WHERE key = ?").get(key)?.value
}

export function setMeta(db: Database, key: string, value: string) {
  db.query<unknown, [string, string]>(`
    INSERT INTO index_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}
