-- D1 schema for the shared comment backend.
-- Apply with:  npx wrangler d1 execute <YOUR_DB_NAME> --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS threads (
  id      TEXT PRIMARY KEY,
  doc     TEXT NOT NULL,   -- matches CommentLayer.docId, so one DB can hold many docs
  tab     TEXT NOT NULL,   -- page id the thread is anchored on
  exact   TEXT NOT NULL,   -- the quoted text (a pin: label of what it sits on)
  prefix  TEXT NOT NULL,   -- context before the quote (for re-anchoring)
  suffix  TEXT NOT NULL,   -- context after the quote (empty for pins)
  created INTEGER NOT NULL,
  pin     TEXT             -- JSON {path,x,y,rx,ry} for a click-dropped pin; NULL for text
);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  doc       TEXT NOT NULL,
  name      TEXT NOT NULL,
  body      TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  owner     TEXT NOT NULL   -- random per-browser token; gates author-only delete
);

CREATE INDEX IF NOT EXISTS idx_threads_doc     ON threads (doc);
CREATE INDEX IF NOT EXISTS idx_messages_doc     ON messages (doc);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id);
