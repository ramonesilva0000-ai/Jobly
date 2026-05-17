// Phase 5 — send application emails via Gmail SMTP.
//
// Only invoked when:
//   - match.recommended_action === 'auto_apply' (gated by auto_apply_threshold
//     in settings.json — defaulted to 99 in this build, so nothing auto-sends
//     until the user explicitly lowers it)
//   - application_method === 'email' AND application_target is a real address
//   - SMTP_USER and SMTP_PASS are both set in .env
//
// BCCs the candidate on every send so they have a paper trail and can audit
// outbound applications.

const nodemailer = require('nodemailer');
const fs = require('node:fs');

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set to send mail');
  }
  _transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
  });
  return _transporter;
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

async function sendApplication({
  to, subject, bodyText, resumePath, coverLetterPath, bcc, logger,
}) {
  if (!isValidEmail(to)) {
    throw new Error(`invalid recipient email: ${to}`);
  }
  if (!fs.existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);
  if (!fs.existsSync(coverLetterPath)) throw new Error(`cover letter not found: ${coverLetterPath}`);

  const transporter = getTransporter();
  const from = process.env.SMTP_USER;

  const info = await transporter.sendMail({
    from,
    to,
    bcc: bcc || from,
    subject,
    text: bodyText,
    attachments: [
      { filename: 'Kiprono_Collins_Resume.docx', path: resumePath },
      { filename: 'Kiprono_Collins_Cover_Letter.docx', path: coverLetterPath },
    ],
  });

  if (logger) logger.info({ to, message_id: info.messageId }, 'application email sent');
  return { messageId: info.messageId };
}

async function sendDigest({ to, subject, bodyText, bodyHtml, logger }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_USER;
  const info = await transporter.sendMail({
    from, to,
    subject,
    text: bodyText,
    ...(bodyHtml ? { html: bodyHtml } : {}),
  });
  if (logger) logger.info({ to, message_id: info.messageId }, 'digest email sent');
  return { messageId: info.messageId };
}

module.exports = { sendApplication, sendDigest, isValidEmail };
