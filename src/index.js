require('dotenv').config();

const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const poller = require('./poller');
const { runDigest } = require('./digest');

async function main() {
  // Initialize the DB up-front so any schema errors surface immediately.
  db.getDb();
  logger.info({ db_path: db.DB_PATH, node: process.version }, 'jobly starting');

  const args = new Set(process.argv.slice(2));
  if (args.has('--once')) {
    const results = await poller.runOnce();
    const failed = results.filter((r) => !r.ok);
    process.exit(failed.length > 0 ? 1 : 0);
  }

  poller.start({
    cronExpression: process.env.POLL_CRON,
    timezone: process.env.TIMEZONE,
    runOnStart: true,
  });

  // Daily digest at DIGEST_CRON (default 19:00 in TIMEZONE).
  const digestCron = process.env.DIGEST_CRON || '0 19 * * *';
  const tz = process.env.TIMEZONE || 'Africa/Nairobi';
  if (cron.validate(digestCron)) {
    logger.info({ cron: digestCron, tz }, 'scheduling daily digest');
    cron.schedule(digestCron, () => {
      runDigest().catch((err) => logger.error({ err: err.message }, 'unhandled digest error'));
    }, { timezone: tz });
  } else {
    logger.warn({ DIGEST_CRON: digestCron }, 'invalid DIGEST_CRON; digest disabled');
  }

  // Keep the process alive; pm2 / termux-services will manage restarts.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function shutdown() {
  logger.info('shutdown signal received');
  try { db.close(); } catch (_) { /* noop */ }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal error during startup');
  process.exit(1);
});
