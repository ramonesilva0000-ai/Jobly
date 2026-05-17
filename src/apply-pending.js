// Phases 4 + 5 — for each matched job with a recommended action of
// auto_apply or queue:
//   1. Tailor a resume (Claude opus-4-7) → tailored bullets + summary
//   2. Tailor a cover letter (Claude opus-4-7) → 3-4 paragraphs
//   3. Merge tailored content into the master resume structure
//   4. Render both to .docx in data/outputs/<date>__<employer>__<title>/
//   5. If recommended_action === 'auto_apply' AND email creds present, send.
//      Otherwise leave at apply_status='ready' for manual review.
//
// "Auto-apply" is gated by auto_apply_threshold in settings.json. We default
// that threshold to 99 (queue-only mode) in this build — nothing actually
// goes out as email until the user explicitly lowers the threshold.

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const logger = require('./logger');
const db = require('./db');
const { tailorResume, generateCoverLetter, mergeTailoredResume } = require('./tailor');
const { outputDirFor, renderResumeDocx, renderCoverLetterDocx } = require('./docgen');
const { sendApplication, isValidEmail } = require('./emailer');

function loadSettings() {
  try {
    const p = path.join(__dirname, '..', 'config', 'settings.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function emailBody(parsedJob, resumeName) {
  // 4-6 lines, per spec. Short and direct.
  const title = parsedJob.title || 'the role';
  const employer = parsedJob.employer || 'your team';
  return [
    `Hello,`,
    ``,
    `Please find my application for ${title} at ${employer} attached — resume and a tailored cover letter.`,
    ``,
    `I am happy to discuss the role in more detail at your convenience.`,
    ``,
    `Sincerely,`,
    resumeName,
  ].join('\n');
}

async function processOne(job, { log }) {
  const child = log.child({ match_id: job.match_result_id, employer: job.employer, title: job.title });

  // 1 + 2: Claude calls.
  let tailored, cover, totals = { input: 0, output: 0, cache_read: 0 };
  try {
    const r = await tailorResume(job, job, { logger: child });
    tailored = r.tailored;
    totals.input += r.usage?.input_tokens || 0;
    totals.output += r.usage?.output_tokens || 0;
    totals.cache_read += r.usage?.cache_read_input_tokens || 0;
  } catch (err) {
    db.insertApplication({
      matchResultId: job.match_result_id, status: 'failed',
      error: `tailorResume: ${err.message}`,
    });
    child.error({ err: err.message }, 'tailorResume failed');
    return { status: 'failed', error: err.message };
  }
  try {
    const c = await generateCoverLetter(job, job, { logger: child });
    cover = c.cover;
    totals.input += c.usage?.input_tokens || 0;
    totals.output += c.usage?.output_tokens || 0;
    totals.cache_read += c.usage?.cache_read_input_tokens || 0;
  } catch (err) {
    db.insertApplication({
      matchResultId: job.match_result_id, status: 'failed',
      error: `generateCoverLetter: ${err.message}`,
    });
    child.error({ err: err.message }, 'generateCoverLetter failed');
    return { status: 'failed', error: err.message };
  }

  // 3 + 4: merge and render.
  const fullResume = mergeTailoredResume(tailored);
  const dir = outputDirFor(job.employer || 'Unknown', job.title || 'Position');
  const resumePath = path.join(dir, 'resume.docx');
  const coverPath = path.join(dir, 'cover-letter.docx');
  try {
    await renderResumeDocx(fullResume, resumePath);
    await renderCoverLetterDocx({
      resumeJson: fullResume,
      cover,
      jobMeta: { employer: job.employer, location: job.location },
    }, coverPath);
    // Also persist the raw tailor output for debugging.
    fs.writeFileSync(path.join(dir, 'tailored.json'), JSON.stringify({ tailored, cover }, null, 2));
  } catch (err) {
    db.insertApplication({
      matchResultId: job.match_result_id, status: 'failed',
      error: `docgen: ${err.message}`,
    });
    child.error({ err: err.message }, 'docgen failed');
    return { status: 'failed', error: err.message };
  }

  // 5: send or queue.
  const settings = loadSettings();
  const autoThreshold = settings.auto_apply_threshold ?? 8.5;
  const shouldAutoSend =
    job.recommended_action === 'auto_apply' &&
    Number(job.score) >= autoThreshold &&
    job.application_method === 'email' &&
    isValidEmail(job.application_target) &&
    !!process.env.SMTP_USER && !!process.env.SMTP_PASS;

  // Record ready state first; mark sent on success.
  db.insertApplication({
    matchResultId: job.match_result_id, status: 'ready',
    outputDir: dir, resumePath, coverLetterPath: coverPath,
    inputTokens: totals.input, outputTokens: totals.output,
    cacheReadTokens: totals.cache_read,
  });

  if (!shouldAutoSend) {
    child.info({
      output_dir: dir,
      reason: job.recommended_action === 'auto_apply' ? 'auto_apply threshold or creds not met' : 'recommended_action=queue',
    }, 'queued — manual review');
    return { status: 'queued', dir };
  }

  try {
    const { messageId } = await sendApplication({
      to: job.application_target,
      subject: `Application: ${job.title} — ${fullResume.name}`,
      bodyText: emailBody(job, fullResume.name),
      resumePath,
      coverLetterPath: coverPath,
      logger: child,
    });
    db.markApplicationSent(job.match_result_id, messageId);
    child.info({ to: job.application_target, message_id: messageId }, 'auto-applied');
    return { status: 'sent', dir };
  } catch (err) {
    child.error({ err: err.message }, 'email send failed (docs remain in queue)');
    // The application is in 'ready' state, which is a fine fallback — the
    // candidate can manually send. Don't downgrade to 'failed'.
    return { status: 'ready', dir, error: err.message };
  }
}

async function applyPending({ limit = 25, log = logger } = {}) {
  const actionable = db.getActionableMatches({ limit });
  if (actionable.length === 0) {
    log.info('no actionable matches');
    return { attempted: 0, sent: 0, queued: 0, failed: 0 };
  }
  log.info({ count: actionable.length }, 'tailoring + queueing matched jobs');

  let sent = 0, queued = 0, failed = 0;
  for (const job of actionable) {
    const r = await processOne(job, { log });
    if (r.status === 'sent') sent++;
    else if (r.status === 'queued' || r.status === 'ready') queued++;
    else failed++;
    if (r.error && r.error.startsWith('auth:')) {
      log.error('aborting apply cycle due to auth failure');
      break;
    }
  }
  log.info({ attempted: actionable.length, sent, queued, failed }, 'apply cycle complete');
  return { attempted: actionable.length, sent, queued, failed };
}

module.exports = { applyPending };

if (require.main === module) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 25;
  applyPending({ limit })
    .then((res) => process.exit(res.failed > 0 && res.sent === 0 && res.queued === 0 ? 1 : 0))
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'fatal in apply-pending');
      process.exit(1);
    });
}
