// Self-check: imports every module and prints a summary. No network calls.
// Useful as a sanity check after install or when adding a new adapter.

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');

function ok(label, detail = '') {
  console.log(`  OK  ${label}${detail ? '  ' + detail : ''}`);
}

function fail(label, err) {
  console.log(`  FAIL ${label}: ${err.message}`);
  process.exitCode = 1;
}

console.log('Jobly self-check');

try {
  const logger = require('./logger');
  ok('logger');
  logger.debug('check.js loaded logger');
} catch (e) { fail('logger', e); }

try {
  const rl = require('./ratelimit');
  if (typeof rl.createTokenBucket !== 'function') throw new Error('missing createTokenBucket');
  if (typeof rl.createPerKeyThrottle !== 'function') throw new Error('missing createPerKeyThrottle');
  ok('ratelimit');
} catch (e) { fail('ratelimit', e); }

try {
  const db = require('./db');
  db.getDb();
  ok('db', `(${db.DB_PATH})`);
} catch (e) { fail('db', e); }

try {
  const base = require('./sources/_base');
  if (typeof base.fetchHtml !== 'function') throw new Error('missing fetchHtml');
  if (typeof base.fetchRss !== 'function') throw new Error('missing fetchRss');
  if (typeof base.makeId !== 'function') throw new Error('missing makeId');
  ok('sources/_base', `(UA: ${base.userAgent()})`);
} catch (e) { fail('sources/_base', e); }

try {
  const cfgPath = path.join(__dirname, '..', 'config', 'sources.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const enabled = (cfg.sources || []).filter((s) => s.enabled);
  ok('config/sources.json', `(${enabled.length} enabled)`);
  for (const s of enabled) {
    try {
      const adapter = require(path.join(__dirname, 'sources', `${s.name}.js`));
      if (!adapter || adapter.name !== s.name) throw new Error('adapter name mismatch');
      if (typeof adapter.fetchNewJobs !== 'function') throw new Error('missing fetchNewJobs');
      ok(`adapter:${s.name}`);
    } catch (e) { fail(`adapter:${s.name}`, e); }
  }
} catch (e) { fail('config/sources.json', e); }

try {
  const poller = require('./poller');
  if (typeof poller.runOnce !== 'function') throw new Error('missing runOnce');
  if (typeof poller.start !== 'function') throw new Error('missing start');
  ok('poller');
} catch (e) { fail('poller', e); }

try {
  const parser = require('./parser');
  if (typeof parser.parseJobPosting !== 'function') throw new Error('missing parseJobPosting');
  if (parser.MODEL !== 'claude-sonnet-4-6') throw new Error(`unexpected model: ${parser.MODEL}`);
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  ok('parser', hasKey ? `(model=${parser.MODEL}, API key present)` : `(model=${parser.MODEL}, no API key — parser disabled)`);
} catch (e) { fail('parser', e); }

try {
  const { parsePending } = require('./parse-pending');
  if (typeof parsePending !== 'function') throw new Error('missing parsePending');
  ok('parse-pending');
} catch (e) { fail('parse-pending', e); }

try {
  const resumePath = path.join(__dirname, '..', 'data', 'resume.json');
  if (!fs.existsSync(resumePath)) throw new Error(`missing: ${resumePath}`);
  const resume = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
  if (!resume.name) throw new Error('resume.json missing required "name"');
  if (!Array.isArray(resume.experience) || resume.experience.length === 0)
    throw new Error('resume.json has no experience entries');
  ok('resume.json', `(${resume.name}, ${resume.experience.length} jobs)`);
} catch (e) { fail('resume.json', e); }

try {
  const matcher = require('./matcher');
  if (typeof matcher.scoreJobFit !== 'function') throw new Error('missing scoreJobFit');
  if (matcher.MODEL !== 'claude-sonnet-4-6') throw new Error(`unexpected model: ${matcher.MODEL}`);
  ok('matcher', `(model=${matcher.MODEL})`);
} catch (e) { fail('matcher', e); }

try {
  const { matchPending } = require('./match-pending');
  if (typeof matchPending !== 'function') throw new Error('missing matchPending');
  ok('match-pending');
} catch (e) { fail('match-pending', e); }

if (process.exitCode === 1) {
  console.log('\nSelf-check FAILED.');
} else {
  console.log('\nSelf-check passed.');
}
