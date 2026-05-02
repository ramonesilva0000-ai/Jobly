require('dotenv').config();

const logger = require('./logger');
const db = require('./db');
const poller = require('./poller');

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
