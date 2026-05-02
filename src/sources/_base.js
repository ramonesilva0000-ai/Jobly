// Shared helpers + adapter conventions.
//
// Exported helpers:
//   - userAgent()                 : the polite UA string
//   - fetchHtml(url, opts)        : axios GET with throttle + retries
//   - fetchRss(url, opts)         : rss-parser GET with throttle + retries
//   - makeId(input)               : sha1 hex digest used as external_id
//
// Polite-scraping defaults (per spec):
//   - 1 request/second per host
//   - real User-Agent including a contact email
//   - exponential backoff on 429/5xx, max 3 retries

const crypto = require('node:crypto');
const axios = require('axios');
const RssParser = require('rss-parser');
const { createPerKeyThrottle, sleep } = require('../ratelimit');

const PER_HOST_RPS = Number(process.env.JOBLY_HTTP_PER_HOST_RPS || 1);
const REQ_TIMEOUT_MS = Number(process.env.JOBLY_HTTP_TIMEOUT_MS || 20000);
const MAX_RETRIES = 3;

const hostThrottle = createPerKeyThrottle({ minIntervalMs: Math.ceil(1000 / PER_HOST_RPS) });

function userAgent() {
  const contact = process.env.SCRAPER_CONTACT_EMAIL || 'admin@example.com';
  return `Mozilla/5.0 (compatible; JoblyBot/1.0; +contact: ${contact})`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function backoffDelayMs(attempt) {
  const base = 500;
  const cap = 8000;
  const expo = Math.min(cap, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return expo + jitter;
}

function isRetriable(err) {
  if (!err) return false;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN') return true;
  const status = err.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function withRetries(fn, { logger, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isRetriable(err)) break;
      const delay = backoffDelayMs(attempt);
      if (logger) {
        logger.warn({
          label,
          attempt: attempt + 1,
          delay_ms: delay,
          status: err.response?.status,
          code: err.code,
          msg: err.message,
        }, 'request failed, retrying');
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function fetchHtml(url, { source, logger } = {}) {
  await hostThrottle.wait(hostOf(url));
  return withRetries(async () => {
    const res = await axios.get(url, {
      timeout: REQ_TIMEOUT_MS,
      headers: {
        'User-Agent': userAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 400,
      maxRedirects: 5,
    });
    return res.data;
  }, { logger, label: source ? `fetchHtml:${source}` : 'fetchHtml' });
}

const _rssParser = new RssParser({
  timeout: REQ_TIMEOUT_MS,
  headers: { 'User-Agent': userAgent() },
});

async function fetchRss(url, { source, logger } = {}) {
  await hostThrottle.wait(hostOf(url));
  return withRetries(
    () => _rssParser.parseURL(url),
    { logger, label: source ? `fetchRss:${source}` : 'fetchRss' }
  );
}

function makeId(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

module.exports = {
  userAgent,
  fetchHtml,
  fetchRss,
  makeId,
};
