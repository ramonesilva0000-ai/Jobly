const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const logLevel = process.env.LOG_LEVEL || 'info';
const isDev = process.env.NODE_ENV !== 'production';

function dailyLogPath() {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `jobbot-${d}.log`);
}

// Sync writes keep the lifecycle simple (we have <1 log/sec; perf cost is negligible)
// and avoid sonic-boom races on short-lived `--once` runs.
const fileStream = pino.destination({ dest: dailyLogPath(), sync: true, mkdir: true });

const streams = [{ level: logLevel, stream: fileStream }];
if (isDev) {
  streams.push({
    level: logLevel,
    stream: pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    }),
  });
}

const logger = pino({ level: logLevel, base: { app: 'jobly' } }, pino.multistream(streams));

module.exports = logger;
