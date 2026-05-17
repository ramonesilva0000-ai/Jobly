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
  runMigrations(_db);
  return _db;
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function runMigrations(db) {
  // Add raw_jobs.images for the Kontaken-Telegram adapter (Phase 6 / Phase 3
  // re-scope). Idempotent — safe to run on a fresh DB and on existing ones.
  if (!columnExists(db, 'raw_jobs', 'images')) {
    db.exec('ALTER TABLE raw_jobs ADD COLUMN images TEXT');
  }
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

    CREATE TABLE IF NOT EXISTS parsed_jobs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_job_id          INTEGER NOT NULL UNIQUE
                          REFERENCES raw_jobs(id) ON DELETE CASCADE,
      is_job_posting      INTEGER NOT NULL,
      title               TEXT,
      employer            TEXT,
      location            TEXT,
      remote_ok           INTEGER,
      key_requirements    TEXT,
      responsibilities    TEXT,
      salary              TEXT,
      deadline            TEXT,
      application_method  TEXT,
      application_target  TEXT,
      raw_excerpt         TEXT,
      parse_status        TEXT NOT NULL,
      parse_error         TEXT,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      parsed_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_parsed_jobs_status   ON parsed_jobs(parse_status);
    CREATE INDEX IF NOT EXISTS idx_parsed_jobs_employer ON parsed_jobs(employer);
    CREATE INDEX IF NOT EXISTS idx_parsed_jobs_method   ON parsed_jobs(application_method);

    CREATE TABLE IF NOT EXISTS match_results (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      parsed_job_id       INTEGER NOT NULL UNIQUE
                          REFERENCES parsed_jobs(id) ON DELETE CASCADE,
      score               REAL,
      skills_match        REAL,
      experience_match    REAL,
      location_match      REAL,
      seniority_match     REAL,
      blockers            TEXT,
      highlights          TEXT,
      recommended_action  TEXT,
      match_status        TEXT NOT NULL,
      match_error         TEXT,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      cache_read_tokens   INTEGER,
      matched_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_match_action ON match_results(recommended_action);
    CREATE INDEX IF NOT EXISTS idx_match_score  ON match_results(score);

    CREATE TABLE IF NOT EXISTS applications (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      match_result_id     INTEGER NOT NULL UNIQUE
                          REFERENCES match_results(id) ON DELETE CASCADE,
      apply_status        TEXT NOT NULL,            -- tailoring|ready|sent|failed
      output_dir          TEXT,
      resume_path         TEXT,
      cover_letter_path   TEXT,
      tailored_at         TEXT,
      sent_at             TEXT,
      email_message_id    TEXT,
      apply_error         TEXT,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      cache_read_tokens   INTEGER,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_app_status ON applications(apply_status);
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
    (source, external_id, url, fetched_at, posted_at, raw_title, raw_text, images, content_hash)
  VALUES
    (:source, :external_id, :url, :fetched_at, :posted_at, :raw_title, :raw_text, :images, :content_hash)
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
    images: Array.isArray(post.images) && post.images.length > 0
      ? JSON.stringify(post.images)
      : null,
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

// ────────────────────────────────────────────────────────────────────
// Parsed-job helpers (Phase 2).
// ────────────────────────────────────────────────────────────────────

function getUnparsedRawJobs(limit = 50) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT r.id, r.source, r.external_id, r.url, r.raw_title, r.raw_text,
           r.images, r.fetched_at, r.posted_at
    FROM raw_jobs r
    LEFT JOIN parsed_jobs p ON p.raw_job_id = r.id
    WHERE p.id IS NULL
    ORDER BY r.id ASC
    LIMIT ?
  `).all(limit);
  for (const r of rows) {
    if (typeof r.images === 'string' && r.images.length > 0) {
      try { r.images = JSON.parse(r.images); } catch { r.images = []; }
    } else {
      r.images = [];
    }
  }
  return rows;
}

function insertParsedJob(rawJobId, parsed, usage, status) {
  const db = getDb();
  db.prepare(`
    INSERT INTO parsed_jobs (
      raw_job_id, is_job_posting, title, employer, location, remote_ok,
      key_requirements, responsibilities, salary, deadline,
      application_method, application_target, raw_excerpt,
      parse_status, parse_error, input_tokens, output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(raw_job_id) DO NOTHING
  `).run(
    rawJobId,
    parsed.is_job_posting ? 1 : 0,
    parsed.title,
    parsed.employer,
    parsed.location,
    parsed.remote_ok === null ? null : (parsed.remote_ok ? 1 : 0),
    JSON.stringify(parsed.key_requirements || []),
    JSON.stringify(parsed.responsibilities || []),
    parsed.salary,
    parsed.deadline,
    parsed.application_method,
    parsed.application_target,
    parsed.raw_excerpt,
    status,
    usage?.input_tokens || null,
    usage?.output_tokens || null,
  );
}

function insertParseFailure(rawJobId, errorMessage) {
  const db = getDb();
  db.prepare(`
    INSERT INTO parsed_jobs (
      raw_job_id, is_job_posting, parse_status, parse_error
    ) VALUES (?, 0, 'failed', ?)
    ON CONFLICT(raw_job_id) DO NOTHING
  `).run(rawJobId, errorMessage || 'unknown error');
}

function recentParsedJobs({ limit = 25, onlyJobs = false } = {}) {
  const db = getDb();
  const where = onlyJobs ? "WHERE p.parse_status = 'parsed'" : '';
  return db.prepare(`
    SELECT p.id, p.raw_job_id, p.is_job_posting, p.title, p.employer,
           p.location, p.remote_ok, p.application_method,
           p.application_target, p.salary, p.deadline,
           p.parse_status, p.parse_error,
           p.input_tokens, p.output_tokens, p.parsed_at,
           r.source, r.url
    FROM parsed_jobs p
    JOIN raw_jobs r ON r.id = p.raw_job_id
    ${where}
    ORDER BY p.id DESC
    LIMIT ?
  `).all(limit);
}

// ────────────────────────────────────────────────────────────────────
// Match-result helpers (Phase 3).
// ────────────────────────────────────────────────────────────────────

function getUnmatchedParsedJobs(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT p.id              AS parsed_job_id,
           p.raw_job_id,
           p.title,
           p.employer,
           p.location,
           p.remote_ok,
           p.key_requirements,
           p.responsibilities,
           p.salary,
           p.deadline,
           p.application_method,
           p.application_target,
           r.source,
           r.url
    FROM parsed_jobs p
    JOIN raw_jobs r ON r.id = p.raw_job_id
    LEFT JOIN match_results m ON m.parsed_job_id = p.id
    WHERE p.parse_status = 'parsed'
      AND p.is_job_posting = 1
      AND m.id IS NULL
    ORDER BY p.id ASC
    LIMIT ?
  `).all(limit);
}

function insertMatchResult(parsedJobId, match, usage, status) {
  const db = getDb();
  const breakdown = match.score_breakdown || {};
  db.prepare(`
    INSERT INTO match_results (
      parsed_job_id, score,
      skills_match, experience_match, location_match, seniority_match,
      blockers, highlights, recommended_action,
      match_status, match_error,
      input_tokens, output_tokens, cache_read_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(parsed_job_id) DO NOTHING
  `).run(
    parsedJobId,
    match.score == null ? null : Number(match.score),
    breakdown.skills_match == null ? null : Number(breakdown.skills_match),
    breakdown.experience_match == null ? null : Number(breakdown.experience_match),
    breakdown.location_match == null ? null : Number(breakdown.location_match),
    breakdown.seniority_match == null ? null : Number(breakdown.seniority_match),
    JSON.stringify(match.blockers || []),
    JSON.stringify(match.highlights || []),
    match.recommended_action || null,
    status,
    usage?.input_tokens || null,
    usage?.output_tokens || null,
    usage?.cache_read_input_tokens || null,
  );
}

function insertMatchFailure(parsedJobId, errorMessage) {
  const db = getDb();
  db.prepare(`
    INSERT INTO match_results (parsed_job_id, match_status, match_error)
    VALUES (?, 'failed', ?)
    ON CONFLICT(parsed_job_id) DO NOTHING
  `).run(parsedJobId, errorMessage || 'unknown error');
}

function recentMatchedJobs({ limit = 25, minScore = null, action = null } = {}) {
  const db = getDb();
  const filters = [];
  const args = [];
  if (minScore != null) { filters.push('m.score >= ?'); args.push(minScore); }
  if (action) { filters.push('m.recommended_action = ?'); args.push(action); }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  args.push(limit);
  return db.prepare(`
    SELECT m.id, m.parsed_job_id, m.score, m.recommended_action, m.match_status,
           m.blockers, m.highlights, m.matched_at,
           p.title, p.employer, p.location, p.application_method,
           p.application_target,
           r.source, r.url
    FROM match_results m
    JOIN parsed_jobs p ON p.id = m.parsed_job_id
    JOIN raw_jobs r    ON r.id = p.raw_job_id
    ${where}
    ORDER BY m.score DESC NULLS LAST, m.id DESC
    LIMIT ?
  `).all(...args);
}

// ────────────────────────────────────────────────────────────────────
// Application helpers (Phases 4–5).
// ────────────────────────────────────────────────────────────────────

function getActionableMatches({ limit = 50 } = {}) {
  // Anything the matcher recommended auto_apply or queue, and we haven't
  // already started an application for.
  const db = getDb();
  return db.prepare(`
    SELECT m.id              AS match_result_id,
           m.score,
           m.blockers,
           m.highlights,
           m.recommended_action,
           p.id              AS parsed_job_id,
           p.title,
           p.employer,
           p.location,
           p.remote_ok,
           p.key_requirements,
           p.responsibilities,
           p.salary,
           p.deadline,
           p.application_method,
           p.application_target,
           r.source,
           r.url
    FROM match_results m
    JOIN parsed_jobs p ON p.id = m.parsed_job_id
    JOIN raw_jobs    r ON r.id = p.raw_job_id
    LEFT JOIN applications a ON a.match_result_id = m.id
    WHERE m.match_status = 'matched'
      AND m.recommended_action IN ('auto_apply', 'queue')
      AND a.id IS NULL
    ORDER BY m.score DESC, m.id DESC
    LIMIT ?
  `).all(limit);
}

function insertApplication({
  matchResultId, status, outputDir, resumePath, coverLetterPath,
  inputTokens, outputTokens, cacheReadTokens, error,
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO applications (
      match_result_id, apply_status, output_dir, resume_path, cover_letter_path,
      tailored_at, input_tokens, output_tokens, cache_read_tokens, apply_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_result_id) DO NOTHING
  `).run(
    matchResultId,
    status,
    outputDir || null,
    resumePath || null,
    coverLetterPath || null,
    status === 'ready' || status === 'sent' ? new Date().toISOString() : null,
    inputTokens || null,
    outputTokens || null,
    cacheReadTokens || null,
    error || null,
  );
}

function markApplicationSent(matchResultId, messageId) {
  const db = getDb();
  db.prepare(`
    UPDATE applications
       SET apply_status = 'sent',
           sent_at = datetime('now'),
           email_message_id = ?
     WHERE match_result_id = ?
  `).run(messageId || null, matchResultId);
}

function recentApplications({ limit = 25, status = null } = {}) {
  const db = getDb();
  const filter = status ? 'WHERE a.apply_status = ?' : '';
  const args = status ? [status, limit] : [limit];
  return db.prepare(`
    SELECT a.id, a.match_result_id, a.apply_status, a.output_dir,
           a.resume_path, a.cover_letter_path,
           a.tailored_at, a.sent_at, a.apply_error,
           m.score, m.recommended_action,
           p.title, p.employer, p.location,
           p.application_method, p.application_target,
           r.source, r.url
    FROM applications a
    JOIN match_results m ON m.id = a.match_result_id
    JOIN parsed_jobs   p ON p.id = m.parsed_job_id
    JOIN raw_jobs      r ON r.id = p.raw_job_id
    ${filter}
    ORDER BY a.id DESC
    LIMIT ?
  `).all(...args);
}

function todaysDigestRows() {
  // Anything sent or readied today, for the 7pm summary email.
  const db = getDb();
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const cutoff = since.toISOString();
  return {
    sent: db.prepare(`
      SELECT a.id, a.sent_at, p.title, p.employer, p.application_target, r.url
      FROM applications a
      JOIN match_results m ON m.id = a.match_result_id
      JOIN parsed_jobs   p ON p.id = m.parsed_job_id
      JOIN raw_jobs      r ON r.id = p.raw_job_id
      WHERE a.apply_status = 'sent' AND a.sent_at >= ?
      ORDER BY a.sent_at DESC
    `).all(cutoff),
    queued: db.prepare(`
      SELECT a.id, a.tailored_at, m.score, p.title, p.employer,
             p.application_method, p.application_target, r.url,
             a.resume_path, a.cover_letter_path
      FROM applications a
      JOIN match_results m ON m.id = a.match_result_id
      JOIN parsed_jobs   p ON p.id = m.parsed_job_id
      JOIN raw_jobs      r ON r.id = p.raw_job_id
      WHERE a.apply_status = 'ready' AND a.tailored_at >= ?
      ORDER BY m.score DESC
    `).all(cutoff),
    skipped_count: db.prepare(`
      SELECT COUNT(*) AS n
      FROM match_results
      WHERE recommended_action = 'skip' AND matched_at >= ?
    `).get(cutoff).n,
  };
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
  getUnparsedRawJobs,
  insertParsedJob,
  insertParseFailure,
  recentParsedJobs,
  getUnmatchedParsedJobs,
  insertMatchResult,
  insertMatchFailure,
  recentMatchedJobs,
  getActionableMatches,
  insertApplication,
  markApplicationSent,
  recentApplications,
  todaysDigestRows,
  contentHash,
  close,
  DB_PATH,
};
