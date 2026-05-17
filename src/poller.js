const fs = require('node:fs');
const path = require('node:path');
const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const { parsePending } = require('./parse-pending');
const { matchPending } = require('./match-pending');
const { applyPending } = require('./apply-pending');

const SOURCES_CONFIG = path.join(__dirname, '..', 'config', 'sources.json');

function loadSourcesConfig() {
  const raw = fs.readFileSync(SOURCES_CONFIG, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.sources || [];
}

function loadAdapter(name) {
  // Adapters live at src/sources/<name>.js
  // require() is sync; cached on subsequent calls.
  const adapterPath = path.join(__dirname, 'sources', `${name}.js`);
  if (!fs.existsSync(adapterPath)) {
    throw new Error(`adapter file not found: ${adapterPath}`);
  }
  return require(adapterPath);
}

async function runOneAdapter(sourceCfg) {
  const log = logger.child({ source: sourceCfg.name });
  const startedAt = new Date().toISOString();
  let adapter;
  try {
    adapter = loadAdapter(sourceCfg.name);
  } catch (err) {
    log.error({ err: err.message }, 'failed to load adapter');
    db.recordPollRun({
      source: sourceCfg.name,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: false,
      error: `load: ${err.message}`,
    });
    return { source: sourceCfg.name, ok: false, added: 0, dupes: 0, error: err.message };
  }

  try {
    log.info('polling source');
    const posts = await adapter.fetchNewJobs({ logger: log, config: sourceCfg });
    if (!Array.isArray(posts)) {
      throw new Error(`adapter returned non-array: ${typeof posts}`);
    }
    const { added, dupes } = db.insertRawJobs(posts);
    log.info({ fetched: posts.length, added, dupes }, 'poll cycle finished');
    db.recordPollRun({
      source: sourceCfg.name,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: true,
      new_count: added,
      dupe_count: dupes,
    });
    return { source: sourceCfg.name, ok: true, fetched: posts.length, added, dupes };
  } catch (err) {
    log.error({ err: err.message, stack: err.stack }, 'adapter run failed');
    db.recordPollRun({
      source: sourceCfg.name,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ok: false,
      error: err.message,
    });
    return { source: sourceCfg.name, ok: false, error: err.message };
  }
}

async function runOnce() {
  const sources = loadSourcesConfig().filter((s) => s.enabled);
  if (sources.length === 0) {
    logger.warn('no enabled sources in config/sources.json');
    return [];
  }
  logger.info({ count: sources.length, sources: sources.map((s) => s.name) }, 'starting poll cycle');
  const results = [];
  for (const s of sources) {
    // Sequential per-source; each adapter's _base helper handles its own per-host throttle.
    // One failure must not stop the others — runOneAdapter swallows errors and returns a result.
    results.push(await runOneAdapter(s));
  }
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    new_jobs: results.reduce((acc, r) => acc + (r.added || 0), 0),
  };
  logger.info(summary, 'poll cycle complete');

  // Parse, match, apply (Phases 2-5). Skip if no Anthropic key — useful
  // for dev environments testing only the polling layer.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      await parsePending({ log: logger });
    } catch (err) {
      logger.error({ err: err.message }, 'parse cycle errored');
    }
    try {
      await matchPending({ log: logger });
    } catch (err) {
      logger.error({ err: err.message }, 'match cycle errored');
    }
    try {
      await applyPending({ log: logger });
    } catch (err) {
      logger.error({ err: err.message }, 'apply cycle errored');
    }
  } else {
    logger.warn('ANTHROPIC_API_KEY not set — skipping parse + match + apply cycles');
  }

  return results;
}

function start({ cronExpression, runOnStart = true, timezone } = {}) {
  const expr = cronExpression || process.env.POLL_CRON || '*/30 * * * *';
  const tz = timezone || process.env.TIMEZONE || 'Africa/Nairobi';

  if (!cron.validate(expr)) {
    throw new Error(`invalid POLL_CRON expression: ${expr}`);
  }

  logger.info({ cron: expr, tz }, 'scheduling poller');
  const task = cron.schedule(expr, () => {
    runOnce().catch((err) => logger.error({ err: err.message }, 'unhandled poll error'));
  }, { timezone: tz });

  if (runOnStart) {
    setImmediate(() => {
      runOnce().catch((err) => logger.error({ err: err.message }, 'unhandled initial-run error'));
    });
  }

  return task;
}

module.exports = { runOnce, start, loadSourcesConfig, runOneAdapter };
