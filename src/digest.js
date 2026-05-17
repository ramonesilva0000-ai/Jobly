// Phase 5 — daily digest email.
// Cron: DIGEST_CRON (default "0 19 * * *", i.e. 19:00 in TIMEZONE).
//
// Sends DIGEST_TO a summary of the day: auto-applied, queued, skipped.
// In queue-only mode (auto_apply_threshold=99) the "auto-applied" section
// will be empty most days — the queued section is what to review.

require('dotenv').config();

const logger = require('./logger');
const db = require('./db');
const { sendDigest } = require('./emailer');

function format(rows) {
  const { sent, queued, skipped_count } = rows;
  const lines = [];
  lines.push(`Jobly daily digest — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Auto-applied: ${sent.length}`);
  for (const a of sent) {
    lines.push(`  • ${a.title || '(no title)'} @ ${a.employer || '?'}`);
    lines.push(`      ${a.application_target}  ${a.url || ''}`);
  }
  lines.push('');
  lines.push(`Queued for manual review: ${queued.length}`);
  for (const a of queued) {
    const score = a.score == null ? '' : ` (score ${Number(a.score).toFixed(1)})`;
    lines.push(`  • ${a.title || '(no title)'} @ ${a.employer || '?'}${score}`);
    lines.push(`      method: ${a.application_method || '?'}  target: ${a.application_target || '(see post)'}`);
    lines.push(`      docs:   ${a.resume_path}`);
    lines.push(`              ${a.cover_letter_path}`);
    if (a.url) lines.push(`      post:   ${a.url}`);
  }
  lines.push('');
  lines.push(`Skipped today: ${skipped_count}`);
  return lines.join('\n');
}

async function runDigest({ log = logger } = {}) {
  const to = process.env.DIGEST_TO;
  if (!to) {
    log.warn('DIGEST_TO not set — skipping digest email');
    return { ok: false, reason: 'DIGEST_TO unset' };
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    log.warn('SMTP creds missing — skipping digest email');
    return { ok: false, reason: 'SMTP creds unset' };
  }

  const rows = db.todaysDigestRows();
  const body = format(rows);
  const subject = `Jobly digest — ${rows.sent.length} applied, ${rows.queued.length} queued`;

  try {
    const { messageId } = await sendDigest({ to, subject, bodyText: body, logger: log });
    log.info({ to, message_id: messageId }, 'digest sent');
    return { ok: true, sent: rows.sent.length, queued: rows.queued.length };
  } catch (err) {
    log.error({ err: err.message }, 'digest send failed');
    return { ok: false, reason: err.message };
  }
}

module.exports = { runDigest, format };

if (require.main === module) {
  runDigest()
    .then((res) => process.exit(res.ok ? 0 : 1))
    .catch((err) => { logger.error({ err: err.message }, 'fatal'); process.exit(1); });
}
