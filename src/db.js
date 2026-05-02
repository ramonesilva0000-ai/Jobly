// SQLite wrapper. Uses Node's built-in `node:sqlite` module (stable in Node
// 22.13+ and 24+). This avoids better-sqlite3's native build, which doesn't
// play nicely with Termux/Android (binding.gyp expects an Android NDK that
// Termux doesn't ship).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.JOBLY_DB_PATH || path.join(DATA_DIR, 'jobs.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
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

// node:sqlite supports named parameters with `:name` (or `@name`/`$name`)
// in the SQL and an object on .run/.all/.get.
const _insertSql = `
  INSERT INTO raw_jobs
    (source, external_id, url, fetched_at, posted_at, raw_title, raw_text, content_hash)
  VALUES
    (:source, :external_id, :url, :fetched_at, :posted_at, :raw_title, :raw_text, :content_hash)
  ON CONFLICT(source, external_id) DO NOTHING
`;

function rowFromPost(post) {
  return {
    source: post.source,
    external_id: post.external_id,
    url: post.url || null,
    fetched_at: post.fetched_at || new Date().toISOString(),
    posted_at: post.posted_at || null,
    raw_title: post.raw_title || null,
    raw_text: post.raw_text || null,
    content_hash: contentHash(post),
  };
}

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  }
}

function insertRawJob(post) {
  const db = getDb();
  const stmt = db.prepare(_insertSql);
  const result = stmt.run(rowFromPost(post));
  return Number(result.changes) === 1; // true => newly inserted, false => duplicate
}

function insertRawJobs(posts) {
  const db = getDb();
  const stmt = db.prepare(_insertSql);
  return withTransaction(db, () => {
    let added = 0;
    let dupes = 0;
    for (const p of posts) {
      const r = stmt.run(rowFromPost(p));
      if (Number(r.changes) === 1) added++;
      else dupes++;
    }
    return { added, dupes };
  });
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
