// Phase 2 — fetch unparsed raw_jobs and run parser on each.
//
// Used both as a CLI (`npm run parse`) and from the poller after each cycle.

require('dotenv').config();

const logger = require('./logger');
const db = require('./db');
const { parseJobPosting } = require('./parser');

async function parsePending({ limit = 50, log = logger } = {}) {
  const pending = db.getUnparsedRawJobs(limit);
  if (pending.length === 0) {
    log.info('no unparsed raw jobs');
    return { attempted: 0, parsed: 0, skipped: 0, failed: 0 };
  }

  log.info({ count: pending.length }, 'parsing pending raw jobs');

  let parsed = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of pending) {
    const child = log.child({ raw_id: raw.id, source: raw.source });
    try {
      const result = await parseJobPosting(raw.raw_title, raw.raw_text, {
        images: Array.isArray(raw.images) ? raw.images : [],
        logger: child,
      });
      const status = result.parsed.is_job_posting ? 'parsed' : 'skipped:not_job';
      db.insertParsedJob(raw.id, result.parsed, result.usage, status);

      if (result.parsed.is_job_posting) {
        parsed++;
        child.info({
          title: result.parsed.title,
          employer: result.parsed.employer,
          method: result.parsed.application_method,
          location: result.parsed.location,
        }, 'parsed (is_job)');
      } else {
        skipped++;
        child.info({ title: raw.raw_title }, 'parsed (not_job)');
      }
    } catch (err) {
      failed++;
      db.insertParseFailure(raw.id, err.message);
      child.error({ err: err.message }, 'parse failed');

      // If auth fails, every subsequent call will too — bail early.
      if (err.message.startsWith('auth:')) {
        log.error('aborting parse cycle due to auth failure');
        break;
      }
    }
  }

  log.info({ attempted: pending.length, parsed, skipped, failed }, 'parse cycle complete');
  return { attempted: pending.length, parsed, skipped, failed };
}

module.exports = { parsePending };

if (require.main === module) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 50;
  parsePending({ limit })
    .then((res) => {
      process.exit(res.failed > 0 && res.parsed === 0 && res.skipped === 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'fatal in parse-pending');
      process.exit(1);
    });
}
