// Kontaken Job Updates — Telegram channel @kjupdates.
//
// We scrape the public preview page (t.me/s/<channel>) rather than using the
// Bot API (can't read third-party channels) or MTProto (requires a real
// account login, account-flag risk). The preview is server-rendered HTML
// with the most recent ~20 posts. Most posts on this channel are images of
// job flyers — we pull image URLs alongside any caption text, and the parser
// handles them via Claude's vision capability.

const cheerio = require('cheerio');
const { fetchHtml, makeId } = require('./_base');

const NAME = 'kontaken-telegram';
const CHANNEL = 'kjupdates';
const PREVIEW_URL = `https://t.me/s/${CHANNEL}`;

module.exports = {
  name: NAME,
  type: 'html',
  enabled: true,
  fetchNewJobs: async ({ logger } = {}) => {
    const html = await fetchHtml(PREVIEW_URL, { source: NAME, logger });
    const $ = cheerio.load(html);
    const fetchedAt = new Date().toISOString();
    const posts = [];

    $('.tgme_widget_message').each((_, el) => {
      const $el = $(el);
      const postId = $el.attr('data-post');           // e.g. "kjupdates/204"
      if (!postId) return;
      const url = `https://t.me/${postId}`;

      const text = $el.find('.tgme_widget_message_text').text().trim();
      const datetime = $el.find('time').attr('datetime') || null;

      // Photos render as a background-image on .tgme_widget_message_photo_wrap.
      const imageUrls = [];
      $el.find('.tgme_widget_message_photo_wrap').each((__, ph) => {
        const style = $(ph).attr('style') || '';
        // Telegram uses single or double quotes in url(); handle both.
        const m = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/);
        if (m) imageUrls.push(m[1]);
      });

      // Skip service messages (joins, edits) that have no body text and no photo.
      if (!text && imageUrls.length === 0) return;

      posts.push({
        source: NAME,
        external_id: makeId(postId),
        url,
        fetched_at: fetchedAt,
        posted_at: datetime,
        raw_title: (text.split('\n')[0] || '').slice(0, 200) || '(image only)',
        raw_text: text,
        images: imageUrls,
      });
    });

    if (logger) logger.info({ count: posts.length }, 'fetched');
    return posts;
  },
};
