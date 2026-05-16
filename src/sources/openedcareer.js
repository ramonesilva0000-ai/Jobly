// Opened Career — Kenyan job listings site.
//
// Strategy: try RSS first (WordPress-style /feed/ is common and gives richer
// post bodies than the listing HTML), fall back to HTML scraping if RSS is
// unavailable or empty. The adapter's declared type is 'html' per the spec.

const cheerio = require('cheerio');
const { fetchHtml, fetchRss, makeId } = require('./_base');

const NAME = 'openedcareer';
const FEED_URL = 'https://openedcareer.com/feed/';
const LIST_URL = 'https://openedcareer.com/';

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function tryRss({ logger } = {}) {
  try {
    const feed = await fetchRss(FEED_URL, { source: NAME, logger });
    const items = feed.items || [];
    const fetchedAt = new Date().toISOString();

    const posts = [];
    for (const item of items) {
      const link = item.link || item.guid;
      if (!link) continue;
      const title = (item.title || '').trim();
      const body = stripHtml(item['content:encoded'] || item.content || item.contentSnippet || '');
      if (!title && !body) continue;

      posts.push({
        source: NAME,
        external_id: makeId(link),
        url: link,
        fetched_at: fetchedAt,
        posted_at: item.isoDate || item.pubDate || null,
        raw_title: title.slice(0, 300),
        raw_text: body,
      });
    }
    return posts;
  } catch (err) {
    if (logger) logger.warn({ err: err.message }, 'RSS attempt failed; will try HTML');
    return null;
  }
}

async function tryHtml({ logger } = {}) {
  const html = await fetchHtml(LIST_URL, { source: NAME, logger });
  const $ = cheerio.load(html);
  const fetchedAt = new Date().toISOString();

  // WordPress sites commonly mark posts with <article>; fall back to common
  // class names. We dedupe by URL so overlapping selectors don't double-count.
  const seen = new Set();
  const posts = [];

  $('article, .post, .entry, .job-listing, .job, .type-post').each((_, el) => {
    const $el = $(el);
    const $title = $el.find('h1 a, h2 a, h3 a, .entry-title a').first();
    const href = $title.attr('href');
    const title = $title.text().trim();
    if (!href || !title) return;
    if (seen.has(href)) return;
    seen.add(href);

    const excerpt =
      $el.find('.entry-summary, .excerpt, .entry-content p').first().text().trim() ||
      $el.find('p').first().text().trim();

    posts.push({
      source: NAME,
      external_id: makeId(href),
      url: href,
      fetched_at: fetchedAt,
      posted_at: null,
      raw_title: title.slice(0, 300),
      raw_text: excerpt,
    });
  });

  return posts;
}

module.exports = {
  name: NAME,
  type: 'html',
  enabled: true,
  fetchNewJobs: async ({ logger } = {}) => {
    const rssPosts = await tryRss({ logger });
    if (rssPosts && rssPosts.length > 0) {
      if (logger) logger.info({ count: rssPosts.length, via: 'rss' }, 'fetched');
      return rssPosts;
    }
    if (logger) logger.info('falling back to HTML listing scrape');
    const htmlPosts = await tryHtml({ logger });
    if (logger) logger.info({ count: htmlPosts.length, via: 'html' }, 'fetched');
    return htmlPosts;
  },
};
