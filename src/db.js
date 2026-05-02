const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.JOBLY_DB_PATH || path.join(DATA_DIR, 'jobs.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      url           TEXT,
      fetched_at    TEXT NOT NULL,
      posted_at     TEXT,
      raw_title     TEXT,
      raw_text      TEXT,
      content_hash  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_raw_jobs_content_hash ON raw_jobs(content_hash);
    CREATE INDEX IF NOT EXISTS idx_raw_jobs_fetched_at  ON raw_jobs(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_raw_jobs_source      ON raw_jobs(source);

    CREATE TABLE IF NOT EXISTS poll_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      ok          INTEGER NOT NULL DEFAULT 0,
      new_count   INTEGER NOT NULL DEFAULT 0,
      dupe_count  INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );
  `);
}

function contentHash(post) {
  const h = crypto.createHash('sha256');
  h.update(post.source || '');
  h.update('\n');
  h.update(post.raw_title || '');
  h.update('\n');
  h.update(post.raw_text || '');
  return h.digest('hex');
}

const _insertStmt = (db) =>
  db.prepare(`
    INSERT INTO raw_jobs
      (source, external_id, url, fetched_at, posted_at, raw_title, raw_text, content_hash)
    VALUES
      (@source, @external_id, @url, @fetched_at, @posted_at, @raw_title, @raw_text, @content_hash)
    ON CONFLICT(source, external_id) DO NOTHING
  `);

function insertRawJob(post) {
  const db = getDb();
  const stmt = _insertStmt(db);
  const row = {
    source: post.source,
    external_id: post.external_id,
    url: post.url || null,
    fetched_at: post.fetched_at || new Date().toISOString(),
    posted_at: post.posted_at || null,
    raw_title: post.raw_title || null,
    raw_text: post.raw_text || null,
    content_hash: contentHash(post),
  };
  const result = stmt.run(row);
  return result.changes === 1; // true => newly inserted, false => duplicate
}

function insertRawJobs(posts) {
  const db = getDb();
  const stmt = _insertStmt(db);
  const tx = db.transaction((items) => {
    let added = 0;
    let dupes = 0;
    for (const p of items) {
      const row = {
        source: p.source,
        external_id: p.external_id,
        url: p.url || null,
        fetched_at: p.fetched_at || new Date().toISOString(),
        posted_at: p.posted_at || null,
        raw_title: p.raw_title || null,
        raw_text: p.raw_text || null,
        content_hash: contentHash(p),
      };
      const r = stmt.run(row);
      if (r.changes === 1) added++;
      else dupes++;
    }
    return { added, dupes };
  });
  return tx(posts);
}

function recordPollRun({ source, started_at, finished_at, ok, new_count, dupe_count, error }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO poll_runs (source, started_at, finished_at, ok, new_count, dupe_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(source, started_at, finished_at, ok ? 1 : 0, new_count || 0, dupe_count || 0, error || null);
}

function recentRawJobs(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT id, source, external_id, url, raw_title, fetched_at, posted_at
    FROM raw_jobs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  insertRawJob,
  insertRawJobs,
  recordPollRun,
  recentRawJobs,
  contentHash,
  close,
  DB_PATH,
};
