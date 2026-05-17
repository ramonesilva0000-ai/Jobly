// Phase 4 — tailor a resume + cover letter for a specific job.
//
// Model: claude-opus-4-7 per the spec. This is the highest-stakes Claude
// call in the pipeline: its output becomes an actual application document
// going out under the candidate's name, so we want the most capable model.
//
// Anti-invention guarantee: the tailor only returns the FIELDS THAT CAN
// CHANGE — the professional summary and per-experience bullet text. The
// concrete facts (employer, title, dates, contact info, education, skills)
// are passed straight through from data/resume.json by docgen. The model
// physically cannot invent a new job, a new employer, or new dates because
// those fields are never in its output schema.

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');
const path = require('node:path');
const { createTokenBucket } = require('./ratelimit');

const MODEL = 'claude-opus-4-7';

const BANNED_WORDS = [
  'leverage', 'leveraging', 'synergize', 'synergy', 'synergies',
  'passionate', 'results-driven', 'team player', 'dynamic',
  'go-getter', 'proactive', 'thought leader', 'rockstar', 'ninja',
];

const RESUME_SYSTEM_PROMPT = `You rewrite specific sections of a resume to emphasize fit for a specific job. You return ONLY:
1. A rewritten "summary" (3–4 sentences, ~80 words).
2. For each existing experience entry, a reordered and rewritten "bullets" array. Each entry must reference an existing employer + title from the candidate's resume — you cannot invent new entries.

You may NOT:
- Invent or remove experience entries.
- Change employer names, job titles, dates, locations, or any concrete numbers.
- Add new metrics, claims, certifications, or skills not present in the master resume.
- Use any of these banned words: leverage, synergize, synergies, passionate, results-driven, team player, dynamic, proactive (as a buzzword), go-getter, thought leader, rockstar, ninja.

You MAY:
- Reorder bullets within an entry to put the most relevant ones first.
- Rephrase bullets for clearer relevance to the job (keep the underlying facts identical — same numbers, same employers, same outcomes).
- Drop bullets that are clearly not relevant to this specific role, but keep at least 3 bullets per current or recent role and at least 1 per older role.
- Tighten the summary to emphasize the parts of the candidate's background most relevant to this job.

Use direct, specific language. No filler. Output JSON only matching the supplied schema.`;

const RESUME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'experience'],
  properties: {
    summary: { type: 'string' },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['employer', 'title', 'bullets'],
        properties: {
          employer: { type: 'string' },
          title: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const COVER_SYSTEM_PROMPT = `You write cover letters that sound like a real person wrote them, not AI.

Rules:
- 300–400 words total in the body. Three or four short paragraphs.
- Open with what specifically drew the candidate to THIS role and THIS employer. Never "I am writing to apply", "I am excited to apply", or "I am thrilled to".
- Body: cite 2–3 concrete achievements from the master resume, each with the actual number from the resume (KES amounts, percentages, counts). Connect each to a stated job requirement.
- Close with one forward-looking sentence that names a concrete next step the candidate would propose — not a closing platitude. Don't say "thank you for your consideration", don't say "I look forward to hearing from you at your earliest convenience".
- No buzzwords. No banned words: leverage, synergize, passionate, results-driven, team player, dynamic, proactive (as a buzzword), go-getter, thought leader.
- Plain professional English. Don't oversell. Don't write what's already on the resume verbatim — paraphrase.

Address line ("to"): if the job posting names a hiring contact (recruiter, hiring manager), use their name. Otherwise use "Hiring Team".

Sign-off and the candidate's name are rendered separately — DO NOT include them in your output. Return only the body paragraphs.

Output JSON:
{
  "to": "Hiring Team" or named contact,
  "paragraphs": ["...", "...", "...", "..."]
}`;

const COVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'paragraphs'],
  properties: {
    to: { type: 'string' },
    paragraphs: { type: 'array', items: { type: 'string' } },
  },
};

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  _client = new Anthropic();
  return _client;
}

let _resumeJson = null;
let _resumeText = null;
function loadResume() {
  if (_resumeJson) return { json: _resumeJson, text: _resumeText };
  const p = path.join(__dirname, '..', 'data', 'resume.json');
  _resumeJson = JSON.parse(fs.readFileSync(p, 'utf8'));
  _resumeText = JSON.stringify(_resumeJson, null, 2);
  return { json: _resumeJson, text: _resumeText };
}

function loadSettings() {
  try {
    const p = path.join(__dirname, '..', 'config', 'settings.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
}

let _limiter = null;
function getLimiter() {
  if (_limiter) return _limiter;
  const rpm = loadSettings().max_anthropic_calls_per_minute || 30;
  _limiter = createTokenBucket({ ratePerInterval: rpm, intervalMs: 60_000 });
  return _limiter;
}

function jobToPromptJson(parsedJob, matchResult) {
  return JSON.stringify({
    title: parsedJob.title,
    employer: parsedJob.employer,
    location: parsedJob.location,
    salary: parsedJob.salary,
    deadline: parsedJob.deadline,
    application_method: parsedJob.application_method,
    application_target: parsedJob.application_target,
    key_requirements: safeArr(parsedJob.key_requirements),
    responsibilities: safeArr(parsedJob.responsibilities),
    matcher_highlights: safeArr(matchResult?.highlights),
    matcher_score: matchResult?.score,
  }, null, 2);
}

function safeArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
}

function containsBannedWord(text) {
  const lower = String(text || '').toLowerCase();
  for (const w of BANNED_WORDS) {
    // Word-boundary-ish match. Cheap; good enough for a final filter.
    const re = new RegExp(`\\b${w.replace(/[-/]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return w;
  }
  return null;
}

async function callClaude({ system, userBlocks, schema, maxTokens, logger }) {
  await getLimiter().take();
  const client = getClient();
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema },
      },
      system,
      messages: [{ role: 'user', content: userBlocks }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new Error(`rate_limit: ${err.message}`);
    if (err instanceof Anthropic.AuthenticationError) throw new Error(`auth: ${err.message}`);
    if (err instanceof Anthropic.BadRequestError) throw new Error(`bad_request: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error('tailor refused the input');
  if (response.stop_reason === 'max_tokens') throw new Error('tailor hit max_tokens');

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block in tailor response');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); }
  catch (err) { throw new Error(`tailor returned non-JSON: ${err.message}`); }

  if (logger) {
    logger.debug({
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_read: response.usage?.cache_read_input_tokens,
    }, 'tailor call');
  }
  return { parsed, usage: response.usage };
}

async function tailorResume(parsedJob, matchResult, { logger } = {}) {
  const { text: resumeText } = loadResume();
  const jobText = jobToPromptJson(parsedJob, matchResult);

  const { parsed, usage } = await callClaude({
    system: RESUME_SYSTEM_PROMPT,
    userBlocks: [
      {
        type: 'text',
        text: `MASTER RESUME (JSON):\n${resumeText}`,
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: `JOB POSTING:\n${jobText}` },
    ],
    schema: RESUME_SCHEMA,
    maxTokens: 3072,
    logger,
  });

  // Anti-invention guard: every (employer, title) the tailor emits must
  // match an entry in the master resume. If not, fail the tailor.
  const { json: master } = loadResume();
  const masterKeys = new Set(
    master.experience.map((e) => `${e.employer}::${e.title}`)
  );
  const inventedEntries = (parsed.experience || []).filter(
    (e) => !masterKeys.has(`${e.employer}::${e.title}`)
  );
  if (inventedEntries.length > 0) {
    throw new Error(
      `tailor invented experience entries: ${inventedEntries
        .map((e) => `${e.employer} / ${e.title}`)
        .join('; ')}`
    );
  }

  // Banned-word guard.
  const allText = [parsed.summary, ...(parsed.experience || []).flatMap((e) => e.bullets || [])].join('\n');
  const banned = containsBannedWord(allText);
  if (banned) {
    throw new Error(`tailor used banned word: "${banned}"`);
  }

  return { tailored: parsed, usage };
}

async function generateCoverLetter(parsedJob, matchResult, { logger } = {}) {
  const { text: resumeText } = loadResume();
  const jobText = jobToPromptJson(parsedJob, matchResult);

  const { parsed, usage } = await callClaude({
    system: COVER_SYSTEM_PROMPT,
    userBlocks: [
      {
        type: 'text',
        text: `MASTER RESUME (JSON):\n${resumeText}`,
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: `JOB POSTING:\n${jobText}` },
    ],
    schema: COVER_SCHEMA,
    maxTokens: 1024,
    logger,
  });

  // Banned-word guard.
  const banned = containsBannedWord(parsed.paragraphs.join('\n'));
  if (banned) throw new Error(`cover letter used banned word: "${banned}"`);

  // Length sanity check.
  const wordCount = parsed.paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  if (wordCount < 200 || wordCount > 500) {
    if (logger) logger.warn({ wordCount }, 'cover letter outside 200–500 word range');
  }

  return { cover: parsed, usage };
}

// Merge the tailor's reordered/rewritten bullets back into the master resume
// so docgen can render a full document. Bullets are matched by (employer,
// title); entries the tailor didn't touch keep their original bullets.
function mergeTailoredResume(tailored) {
  const { json: master } = loadResume();
  const byKey = new Map();
  for (const e of tailored.experience || []) {
    byKey.set(`${e.employer}::${e.title}`, e.bullets);
  }
  return {
    ...master,
    summary: tailored.summary || master.summary,
    experience: master.experience.map((e) => {
      const tailoredBullets = byKey.get(`${e.employer}::${e.title}`);
      return tailoredBullets ? { ...e, bullets: tailoredBullets } : e;
    }),
  };
}

module.exports = {
  tailorResume,
  generateCoverLetter,
  mergeTailoredResume,
  MODEL,
};
