// `npm run jobs` — show parsed + matched jobs.
//
// Flags:
//   --limit=N           # default 25
//   --only-jobs         # parser flagged is_job_posting=true
//   --min-score=N       # minimum match score (forces match-results join)
//   --action=auto_apply # filter by recommended_action
//   --json              # JSON output, one row per line

const db = require('../db');

const args = process.argv.slice(2);
function flagValue(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
}
const limit = Number(flagValue('limit')) || 25;
const onlyJobs = args.includes('--only-jobs');
const minScore = flagValue('min-score') ? Number(flagValue('min-score')) : null;
const action = flagValue('action');
const asJson = args.includes('--json');

const useMatchTable = minScore != null || action != null;

let rows;
if (useMatchTable) {
  rows = db.recentMatchedJobs({ limit, minScore, action });
} else {
  rows = db.recentParsedJobs({ limit, onlyJobs });
  // Decorate with match-result columns by parsed_job_id.
  const matchById = new Map();
  for (const m of db.recentMatchedJobs({ limit: 500 })) {
    matchById.set(m.parsed_job_id, m);
  }
  for (const r of rows) {
    const m = matchById.get(r.id);
    if (m) {
      r.score = m.score;
      r.recommended_action = m.recommended_action;
      r.match_status = m.match_status;
    }
  }
}

if (asJson) {
  for (const r of rows) console.log(JSON.stringify(r));
  db.close();
  process.exit(0);
}

if (rows.length === 0) {
  console.log('(no rows — run `npm run parse` and `npm run match` first)');
  db.close();
  process.exit(0);
}

const fmt = (v, w) => {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ');
  return s.length <= w ? s.padEnd(w) : s.slice(0, w - 1) + '…';
};

console.log(
  fmt('id', 5),
  fmt('source', 13),
  fmt('score', 6),
  fmt('action', 11),
  fmt('method', 11),
  fmt('employer', 22),
  fmt('title', 36),
);
console.log('-'.repeat(120));

for (const r of rows) {
  const score = r.score == null ? '' : Number(r.score).toFixed(1);
  console.log(
    fmt(r.parsed_job_id ?? r.id, 5),
    fmt(r.source, 13),
    fmt(score, 6),
    fmt(r.recommended_action || '', 11),
    fmt(r.application_method || '', 11),
    fmt(r.employer || '', 22),
    fmt(r.title || '(no title)', 36),
  );
}

console.log(`\n${rows.length} row(s). Flags: --limit=N --only-jobs --min-score=N --action=auto_apply|queue|skip --json`);
db.close();
