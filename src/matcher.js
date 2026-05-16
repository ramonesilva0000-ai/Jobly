// Phase 3 — match a parsed job against the candidate's resume.
//
// Model: claude-sonnet-4-6 per the spec.
// Thinking: adaptive, effort=medium. Matching is more nuanced than
// extraction — we want the model to weigh skills, experience, seniority,
// and location against the resume.
// Output: strict JSON via output_config.format.
// Caching: the resume is the same across every call in a batch, so we put
// it in the user message with cache_control on that block. Sonnet 4.6's
// cache minimum is 2048 tokens — the resume comfortably exceeds it.

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');
const path = require('node:path');
const { createTokenBucket } = require('./ratelimit');

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You score how well a candidate fits a job posting. Be strict.

Score guidance (0-10):
- 9-10: candidate clearly meets every stated requirement and the role aligns with their trajectory.
- 7-8: candidate meets most requirements; gaps are minor and recoverable.
- 6: plausible but a stretch — meaningful gap in one of skills / experience / seniority.
- 0-5: skip. Clear mismatch in skills, experience, level, location, or required credentials.

Blockers must be flagged in the "blockers" array. Examples:
- Wrong country with no remote option (target country is Kenya unless the candidate's resume indicates otherwise).
- Requires a credential the candidate clearly doesn't have (e.g. CPA, CFA, ACCA, professional certification not on the resume).
- Requires years of experience the candidate clearly lacks (e.g. "10+ years FMCG" when resume shows 2-3 years).
- Required degree the candidate lacks (resume shows Bachelor's — flag "Master's required" if the post demands it).
- Hard exclusion: post says MLM, commission-only, "join our network", etc.

recommended_action rules:
- "skip" if score < 6 OR there is any blocker.
- "auto_apply" if score >= 8.5 AND application_method == "email" AND blockers is empty.
- "queue" for everything else with score >= 6.

Highlights: 2-4 short, concrete strings explaining why this candidate fits — cite specific resume bullets, numbers, or employers. No filler.

Output JSON only — strict schema, no preamble.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'score',
    'score_breakdown',
    'blockers',
    'highlights',
    'recommended_action',
  ],
  properties: {
    score: { type: 'number' },
    score_breakdown: {
      type: 'object',
      additionalProperties: false,
      required: ['skills_match', 'experience_match', 'location_match', 'seniority_match'],
      properties: {
        skills_match: { type: 'number' },
        experience_match: { type: 'number' },
        location_match: { type: 'number' },
        seniority_match: { type: 'number' },
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    highlights: { type: 'array', items: { type: 'string' } },
    recommended_action: {
      type: 'string',
      enum: ['auto_apply', 'queue', 'skip'],
    },
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

let _resumeText = null;
function loadResumeText() {
  if (_resumeText) return _resumeText;
  const p = path.join(__dirname, '..', 'data', 'resume.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      `resume not found at ${p}. Create data/resume.json before matching.`
    );
  }
  // Re-stringify with 2-space indent for stable, readable bytes — caching is
  // a prefix match on exact bytes, so deterministic serialization matters.
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  _resumeText = JSON.stringify(parsed, null, 2);
  return _resumeText;
}

function loadSettings() {
  try {
    const p = path.join(__dirname, '..', 'config', 'settings.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

let _limiter = null;
function getLimiter() {
  if (_limiter) return _limiter;
  const rpm = loadSettings().max_anthropic_calls_per_minute || 30;
  _limiter = createTokenBucket({ ratePerInterval: rpm, intervalMs: 60_000 });
  return _limiter;
}

function jobToPromptJson(parsedJob) {
  // Hand-pick the fields the matcher actually needs. Drop SQL artifacts.
  const fields = {
    title: parsedJob.title,
    employer: parsedJob.employer,
    location: parsedJob.location,
    remote_ok: parsedJob.remote_ok === 1 || parsedJob.remote_ok === true,
    salary: parsedJob.salary,
    deadline: parsedJob.deadline,
    application_method: parsedJob.application_method,
    application_target: parsedJob.application_target,
    key_requirements: safeParseArray(parsedJob.key_requirements),
    responsibilities: safeParseArray(parsedJob.responsibilities),
  };
  return JSON.stringify(fields, null, 2);
}

function safeParseArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
}

async function scoreJobFit(parsedJob, { logger } = {}) {
  await getLimiter().take();

  const resumeText = loadResumeText();
  const jobText = jobToPromptJson(parsedJob);

  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `CANDIDATE RESUME (JSON):\n${resumeText}`,
              // The resume is identical across every match in a cycle; this
              // makes the prefix (system + resume) cacheable. Subsequent
              // calls within the 5-minute TTL pay ~0.1x for the cached
              // portion.
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `JOB POSTING (JSON):\n${jobText}`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new Error(`rate_limit: ${err.message}`);
    if (err instanceof Anthropic.AuthenticationError) throw new Error(`auth: ${err.message}`);
    if (err instanceof Anthropic.BadRequestError) throw new Error(`bad_request: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error('matcher refused the input');
  if (response.stop_reason === 'max_tokens') throw new Error('matcher hit max_tokens');

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block in matcher response');

  let match;
  try {
    match = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`matcher returned non-JSON: ${err.message}`);
  }

  // Belt-and-braces: re-derive recommended_action from rules + thresholds in
  // case the model disagrees with itself. The schema guarantees a value but
  // not that it matches the score.
  const settings = loadSettings();
  const autoTh = settings.auto_apply_threshold ?? 8.5;
  const queueTh = settings.queue_threshold ?? 6.0;
  const blockers = Array.isArray(match.blockers) ? match.blockers : [];
  let action;
  if (match.score == null || match.score < queueTh || blockers.length > 0) {
    action = 'skip';
  } else if (
    match.score >= autoTh &&
    parsedJob.application_method === 'email'
  ) {
    action = 'auto_apply';
  } else {
    action = 'queue';
  }
  match.recommended_action = action;

  if (logger) {
    logger.debug({
      score: match.score,
      action: match.recommended_action,
      blockers: blockers.length,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      cache_read: response.usage?.cache_read_input_tokens,
    }, 'scored');
  }

  return { match, usage: response.usage, stop_reason: response.stop_reason };
}

module.exports = { scoreJobFit, MODEL, SCHEMA };
