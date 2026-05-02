// Career Point Kenya — RSS adapter (Phase 1 reference adapter).
//
// Source: https://www.careerpointkenya.co.ke/feed/  (WordPress feed)

const { fetchRss, makeId } = require('./_base');

const NAME = 'careerpoint';
const DEFAULT_FEED_URL = 'https://www.careerpointkenya.co.ke/feed/';

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

function makeAdapter({ feedUrl = DEFAULT_FEED_URL } = {}) {
  return {
    name: NAME,
    type: 'rss',
    enabled: true,
    fetchNewJobs: async ({ logger } = {}) => {
      const feed = await fetchRss(feedUrl, { source: NAME, logger });
      const items = feed.items || [];
      const fetchedAt = new Date().toISOString();

      const posts = [];
      for (const item of items) {
        const link = item.link || item.guid;
        if (!link) continue;

        const externalId = makeId(link);
        const rawTitle = (item.title || '').trim();
        const rawText = stripHtml(item['content:encoded'] || item.content || item.contentSnippet || '');
        const postedAt = item.isoDate || item.pubDate || null;

        if (!rawTitle && !rawText) continue;

        posts.push({
          source: NAME,
          external_id: externalId,
          url: link,
          fetched_at: fetchedAt,
          posted_at: postedAt,
          raw_title: rawTitle.slice(0, 300),
          raw_text: rawText,
        });
      }

      return posts;
    },
  };
}

module.exports = makeAdapter();
module.exports.makeAdapter = makeAdapter;
