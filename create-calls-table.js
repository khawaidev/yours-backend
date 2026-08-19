#!/usr/bin/env node
/**
 * Creates the `public.calls` and `public.call_feedback` tables in Supabase
 * via the Management API.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node create-calls-table.js
 *   node create-calls-table.js sbp_xxx
 */
const fs = require('fs');
const path = require('path');

const REF = 'dgbxcakkqrgrapwsvrol';
const sqlPath = path.join(__dirname, 'src', 'db', 'calls.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACESS_TOKEN || process.argv[2];
if (!token) {
  console.error('Missing Supabase access token. Pass it as arg or SUPABASE_ACCESS_TOKEN env.');
  process.exit(1);
}
if (!/^sbp_/.test(token)) {
  console.warn('Warning: token does not start with "sbp_" — it may be rejected.');
}

async function main() {
  console.log('Running SQL against project', REF, '...');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  console.log('HTTP', res.status);
  console.log(text.slice(0, 3000) || '(empty body)');
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
