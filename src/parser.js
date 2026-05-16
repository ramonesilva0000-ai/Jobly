// Phase 2 — job parser.
//
// Calls Claude (claude-sonnet-4-6 per the spec) to extract structured
// fields from a raw posting. Uses Anthropic's structured outputs
// (output_config.format with a JSON schema) so we don't have to coax the
// model into "JSON only" via prompt — the API enforces the shape.
//
// We disable thinking and run at effort=low. This is an extraction task
// over short inputs; Sonnet 4.6 doesn't need reasoning depth here.
//
// Prompt caching: skipped. The system prompt is ~150 tokens, well under
// Sonnet 4.6's 2048-token cache minimum, so cache_control would silently
// be a no-op. Revisit when the prompt grows (few-shot examples, etc.).

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');
const path = require('node:path');
const { createTokenBucket } = require('./ratelimit');

const MODEL = 'claude-sonnet-4-6';

// Hard cap on input length so a runaway HTML scrape doesn't burn tokens.
// Real Kenya job posts are well under this.
const MAX_INPUT_CHARS = 40000;

const SYSTEM_PROMPT = `You extract structured data from text that may contain a job posting. Many inputs won't be jobs — newsletters, ads, articles, or unrelated content. Return strict JSON matching the schema. If a field can't be determined from the input, use null. Do not invent values.

Rules:
- The target country is Kenya unless the post clearly states otherwise. A post for a remote role open to candidates in Kenya is a job; a post for a role in another country with no remote option is still a job (mark location accordingly), but key_requirements should reflect the actual posting.
- application_method must be one of "email", "web_form", "phone", "in_person", or "unclear". Use "email" only if an actual email address is present in the text. Use "web_form" if the post links to a Greenhouse/Workable/LinkedIn/portal URL. Use "phone"/"in_person" only when explicitly stated. Use "unclear" otherwise.
- application_target should be the literal email / URL / phone / address corresponding to application_method, or null.
- raw_excerpt: the first ~200 characters of the post body, useful for sanity checks downstream.
- key_requirements and responsibilities: short bullet-style strings, no leading dashes or numbers.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_job_posting',
    'title',
    'employer',
    'location',
    'remote_ok',
    'key_requirements',
    'responsibilities',
    'salary',
    'deadline',
    'application_method',
    'application_target',
    'raw_excerpt',
  ],
  properties: {
    is_job_posting: { type: 'boolean' },
    title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    employer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    location: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    remote_ok: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    key_requirements: { type: 'array', items: { type: 'string' } },
    responsibilities: { type: 'array', items: { type: 'string' } },
    salary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    deadline: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    application_method: {
      type: 'string',
      enum: ['email', 'web_form', 'phone', 'in_person', 'unclear'],
    },
    application_target: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    raw_excerpt: { type: 'string' },
  },
};

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env to enable parsing.'
    );
  }
  _client = new Anthropic();
  return _client;
}

// Settings live in config/settings.json; load lazily so a missing/malformed
// file doesn't kill the whole module's require.
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

function buildUserText(rawTitle, rawText) {
  const title = (rawTitle || '').trim();
  const body = (rawText || '').slice(0, MAX_INPUT_CHARS).trim();
  return `Title: ${title || '(none)'}\n\nBody:\n${body || '(empty)'}`;
}

async function parseJobPosting(rawTitle, rawText, { images = [], logger } = {}) {
  await getLimiter().take();

  // Build the user message. For text-only posts, a plain string is fine.
  // When images are present (e.g. Telegram flyer screenshots), we send a
  // content array with image blocks alongside the text — Sonnet 4.6 reads
  // the flyer directly via its vision capability.
  let userContent;
  if (Array.isArray(images) && images.length > 0) {
    userContent = [
      { type: 'text', text: buildUserText(rawTitle, rawText) },
    ];
    for (const url of images) {
      userContent.push({ type: 'image', source: { type: 'url', url } });
    }
  } else {
    userContent = buildUserText(rawTitle, rawText);
  }

  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err) {
    // Surface SDK typed errors clearly. The caller categorizes by message.
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error(`rate_limit: ${err.message}`);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error(`auth: ${err.message}`);
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new Error(`bad_request: ${err.message}`);
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('parser refused the input');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('parser hit max_tokens — output truncated');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('no text block in parser response');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`parser returned non-JSON: ${err.message}`);
  }

  if (logger) {
    logger.debug({
      is_job: parsed.is_job_posting,
      title: parsed.title,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
    }, 'parsed posting');
  }

  return { parsed, usage: response.usage, stop_reason: response.stop_reason };
}

module.exports = { parseJobPosting, MODEL, SCHEMA };
