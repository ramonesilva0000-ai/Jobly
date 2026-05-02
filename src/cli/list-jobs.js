// `npm run jobs` — print the most recent parsed jobs for sanity-checking.
//
// Usage:
//   npm run jobs                 # last 25, all statuses
//   npm run jobs -- --limit=50   # last 50
//   npm run jobs -- --only-jobs  # only is_job_posting=true rows

const db = require('../db');

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 25;
const onlyJobs = args.includes('--only-jobs');

const rows = db.recentParsedJobs({ limit, onlyJobs });

if (rows.length === 0) {
  console.log('(no parsed jobs yet — run `npm run parse` first)');
  process.exit(0);
}

const fmtCell = (v, w) => {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ');
  if (s.length <= w) return s.padEnd(w);
  return s.slice(0, w - 1) + '…';
};

console.log(
  fmtCell('id', 5),
  fmtCell('source', 12),
  fmtCell('status', 18),
  fmtCell('method', 11),
  fmtCell('employer', 22),
  fmtCell('title', 40),
);
console.log('-'.repeat(112));

for (const r of rows) {
  console.log(
    fmtCell(r.raw_job_id, 5),
    fmtCell(r.source, 12),
    fmtCell(r.parse_status, 18),
    fmtCell(r.application_method || '', 11),
    fmtCell(r.employer || '', 22),
    fmtCell(r.title || '(no title)', 40),
  );
}

console.log(`\n${rows.length} row(s). Use --limit=N for more, --only-jobs to filter.`);
db.close();
