// Phase 3 — fetch unmatched parsed_jobs and run the matcher on each.

require('dotenv').config();

const logger = require('./logger');
const db = require('./db');
const { scoreJobFit } = require('./matcher');

async function matchPending({ limit = 50, log = logger } = {}) {
  const pending = db.getUnmatchedParsedJobs(limit);
  if (pending.length === 0) {
    log.info('no unmatched parsed jobs');
    return { attempted: 0, scored: 0, failed: 0, by_action: {} };
  }

  log.info({ count: pending.length }, 'matching pending parsed jobs');

  let scored = 0;
  let failed = 0;
  const byAction = { auto_apply: 0, queue: 0, skip: 0 };

  for (const job of pending) {
    const child = log.child({ parsed_id: job.parsed_job_id, source: job.source });
    try {
      const { match, usage } = await scoreJobFit(job, { logger: child });
      db.insertMatchResult(job.parsed_job_id, match, usage, 'matched');
      scored++;
      byAction[match.recommended_action] = (byAction[match.recommended_action] || 0) + 1;
      child.info({
        score: match.score,
        action: match.recommended_action,
        blockers: (match.blockers || []).length,
        title: job.title,
        employer: job.employer,
      }, 'scored');
    } catch (err) {
      failed++;
      db.insertMatchFailure(job.parsed_job_id, err.message);
      child.error({ err: err.message }, 'match failed');
      if (err.message.startsWith('auth:')) {
        log.error('aborting match cycle due to auth failure');
        break;
      }
    }
  }

  log.info({ attempted: pending.length, scored, failed, by_action: byAction }, 'match cycle complete');
  return { attempted: pending.length, scored, failed, by_action: byAction };
}

module.exports = { matchPending };

if (require.main === module) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 50;
  matchPending({ limit })
    .then((res) => {
      process.exit(res.failed > 0 && res.scored === 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'fatal in match-pending');
      process.exit(1);
    });
}
