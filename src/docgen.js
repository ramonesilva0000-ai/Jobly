// Phase 4 — render tailored resume + cover letter to .docx.
//
// We use the `docx` npm package directly rather than a fixed template
// because the master resume isn't a hand-styled .docx, just the structured
// JSON in data/resume.json. Output looks clean and professional in any
// modern word processor; the styling is straightforward enough that a
// manual polish step is easy if the candidate wants it.

const fs = require('node:fs');
const path = require('node:path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle,
} = require('docx');

function safeFilename(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'untitled';
}

function outputDirFor(employer, title) {
  const date = new Date().toISOString().slice(0, 10);
  const folder = `${date}__${safeFilename(employer)}__${safeFilename(title)}`;
  const dir = path.join(__dirname, '..', 'data', 'outputs', folder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function header(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text, bold: true, size: opts.size || 32, ...opts })],
  });
}

function sectionHeader(text) {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    border: { bottom: { color: '666666', style: BorderStyle.SINGLE, size: 6 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 24 })],
  });
}

function line(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 60 },
    children: [new TextRun({ text, size: opts.size || 22, ...opts })],
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: 22 })],
  });
}

function fmtDate(d) {
  if (!d) return '';
  // Accept "2026-03" or "2026-03-15" or "Present" or "2021"
  if (/^\d{4}-\d{2}$/.test(d)) {
    const [y, m] = d.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[Number(m) - 1]} ${y}`;
  }
  return d;
}

async function renderResumeDocx(resumeJson, outputPath) {
  const children = [];

  // Header — name + title + contact.
  children.push(header(resumeJson.name || '', { size: 36 }));
  if (resumeJson.title) {
    children.push(line(resumeJson.title, {
      size: 22, italics: true,
    }));
  }
  const contactBits = [];
  if (resumeJson.contact?.email) contactBits.push(resumeJson.contact.email);
  if (resumeJson.contact?.phone) contactBits.push(resumeJson.contact.phone);
  if (resumeJson.contact?.location) contactBits.push(resumeJson.contact.location);
  if (contactBits.length > 0) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: contactBits.join(' • '), size: 20 })],
    }));
  }

  // Summary.
  if (resumeJson.summary) {
    children.push(sectionHeader('Professional Summary'));
    children.push(line(resumeJson.summary));
  }

  // Core competencies.
  if (Array.isArray(resumeJson.core_competencies) && resumeJson.core_competencies.length) {
    children.push(sectionHeader('Core Competencies'));
    children.push(line(resumeJson.core_competencies.join(' • ')));
  }

  // Experience.
  if (Array.isArray(resumeJson.experience) && resumeJson.experience.length) {
    children.push(sectionHeader('Professional Experience'));
    for (const e of resumeJson.experience) {
      // Title + employer line.
      const dateRange = [fmtDate(e.start), fmtDate(e.end)].filter(Boolean).join(' – ');
      children.push(new Paragraph({
        spacing: { before: 120, after: 0 },
        children: [
          new TextRun({ text: e.title || '', bold: true, size: 22 }),
          new TextRun({ text: '\t' }),
          new TextRun({ text: dateRange, size: 22 }),
        ],
      }));
      const subBits = [e.employer, e.location].filter(Boolean).join(' | ');
      if (subBits) children.push(line(subBits, { size: 20, italics: true, after: 40 }));
      for (const b of (e.bullets || [])) children.push(bullet(b));
    }
  }

  // Education.
  if (Array.isArray(resumeJson.education) && resumeJson.education.length) {
    children.push(sectionHeader('Education'));
    for (const ed of resumeJson.education) {
      const dr = [ed.start, ed.end].filter(Boolean).join(' – ');
      children.push(new Paragraph({
        spacing: { before: 80, after: 0 },
        children: [
          new TextRun({ text: ed.qualification || '', bold: true, size: 22 }),
          new TextRun({ text: '\t' }),
          new TextRun({ text: dr, size: 22 }),
        ],
      }));
      const sub = [ed.institution, ed.location].filter(Boolean).join(' | ');
      if (sub) children.push(line(sub, { size: 20, italics: true, after: 20 }));
      if (ed.focus) children.push(line(`Focus: ${ed.focus}`, { size: 20 }));
    }
  }

  // Skills.
  if (resumeJson.skills) {
    children.push(sectionHeader('Key Skills'));
    const s = resumeJson.skills;
    if (Array.isArray(s.technical) && s.technical.length) {
      children.push(line(`Technical: ${s.technical.join(' • ')}`));
    }
    if (Array.isArray(s.professional) && s.professional.length) {
      children.push(line(`Professional: ${s.professional.join(' • ')}`));
    }
    if (Array.isArray(s.languages) && s.languages.length) {
      children.push(line(`Languages: ${s.languages.join(' • ')}`));
    }
  }

  // Achievements.
  if (Array.isArray(resumeJson.achievements) && resumeJson.achievements.length) {
    children.push(sectionHeader('Selected Achievements'));
    for (const a of resumeJson.achievements) children.push(bullet(a));
  }

  const doc = new Document({
    creator: 'Jobly',
    title: `${resumeJson.name || 'Resume'} — Resume`,
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buf);
}

async function renderCoverLetterDocx({ resumeJson, cover, jobMeta }, outputPath) {
  const children = [];

  // Letterhead (the candidate's contact, top-right or top-left).
  children.push(line(resumeJson.name || '', { bold: true, size: 24 }));
  if (resumeJson.contact?.email) children.push(line(resumeJson.contact.email, { size: 20, after: 0 }));
  if (resumeJson.contact?.phone) children.push(line(resumeJson.contact.phone, { size: 20, after: 0 }));
  if (resumeJson.contact?.location) children.push(line(resumeJson.contact.location, { size: 20, after: 160 }));

  // Date.
  const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  children.push(line(today, { size: 22, after: 160 }));

  // Employer block (optional, when known).
  if (jobMeta?.employer) children.push(line(jobMeta.employer, { bold: true, size: 22, after: 0 }));
  if (jobMeta?.location) children.push(line(jobMeta.location, { size: 22, after: 160 }));

  // Address line.
  const toLine = `Dear ${cover.to || 'Hiring Team'},`;
  children.push(line(toLine, { size: 22, after: 160 }));

  // Body paragraphs.
  for (const p of (cover.paragraphs || [])) {
    children.push(line(p, { size: 22, after: 200 }));
  }

  // Sign-off.
  children.push(line('Sincerely,', { size: 22, after: 320 }));
  children.push(line(resumeJson.name || '', { size: 22, bold: true }));

  const doc = new Document({
    creator: 'Jobly',
    title: `${resumeJson.name || 'Candidate'} — Cover Letter`,
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buf);
}

module.exports = {
  outputDirFor,
  renderResumeDocx,
  renderCoverLetterDocx,
  safeFilename,
};
