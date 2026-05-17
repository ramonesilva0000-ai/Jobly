// `npm run queue` — list applications awaiting manual review or send.
//
// Usage:
//   npm run queue                # last 25, all statuses
//   npm run queue -- --status=ready
//   npm run queue -- --status=sent
//   npm run queue -- --status=failed
//   npm run queue -- --limit=50

const db = require('../db');

const args = process.argv.slice(2);
function flag(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
}
const status = flag('status');           // ready | sent | failed | tailoring | null
const limit = Number(flag('limit')) || 25;

const rows = db.recentApplications({ limit, status });

if (rows.length === 0) {
  console.log(`(no applications${status ? ` with status=${status}` : ''} — run "npm run apply" first)`);
  db.close();
  process.exit(0);
}

const fmt = (v, w) => {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ');
  return s.length <= w ? s.padEnd(w) : s.slice(0, w - 1) + '…';
};

console.log(
  fmt('id', 4),
  fmt('status', 8),
  fmt('score', 5),
  fmt('action', 11),
  fmt('method', 11),
  fmt('employer', 22),
  fmt('title', 36),
);
console.log('-'.repeat(105));

for (const r of rows) {
  const score = r.score == null ? '' : Number(r.score).toFixed(1);
  console.log(
    fmt(r.id, 4),
    fmt(r.apply_status, 8),
    fmt(score, 5),
    fmt(r.recommended_action || '', 11),
    fmt(r.application_method || '', 11),
    fmt(r.employer || '', 22),
    fmt(r.title || '(no title)', 36),
  );
}

console.log('');
console.log('To see docs for one of these, run:');
console.log('  sqlite3 data/jobs.db "SELECT output_dir, resume_path, cover_letter_path FROM applications WHERE id = ID;"');
console.log('Or open the directory:');
console.log('  ls data/outputs/');

db.close();
