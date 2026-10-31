#!/usr/bin/env node
// Verify a pitch end to end from the command line, with no UI and no server.
//   node scripts/check.js samples/zepto.md            readable report
//   node scripts/check.js deck.pptx --json > out.json  full JSON
//   cat pitch.txt | node scripts/check.js -            read from stdin
import '../lib/env.js';
import { readFileSync } from 'node:fs';
import { parsePptx, parseText } from '../lib/pptx.js';
import { checkPitch } from '../lib/verify.js';
import { deckScore } from '../lib/score.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const domainArg = args.find((a) => a.startsWith('--domain='))?.split('=')[1];
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/check.js <pitch.pptx|.md|.txt|-> [--json] [--domain=example.com]');
  process.exit(2);
}
const missing = ['CRUSTDATA_API_KEY', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(' and ')}. Add them to .env.`);
  process.exit(2);
}

const buf = file === '-' ? readFileSync(0) : readFileSync(file);
const slides = /\.pptx$/i.test(file) ? parsePptx(buf) : parseText(buf.toString('utf8'));
const log = (m) => !json && console.error(`… ${m.message}`);
const out = await checkPitch(slides, { onProgress: log, company: domainArg ? { domain: domainArg } : null });
const states = Object.fromEntries(Object.entries(out.results).map(([id, v]) => [id, { verification: v }]));
const summary = deckScore(out.claims, states);

if (json) {
  console.log(JSON.stringify({ ...out, summary, claims: out.claims.map((c) => ({ ...c, verification: out.results[c.id] })) }, null, 2));
  process.exit(0);
}

const ICON = { verified: '✅', partially_verified: '🟡', contradicted: '❌', unverifiable: '❔' };
const r = out.resolution;
console.log(`\nCompany: ${out.company.name} (${out.company.domain ?? 'no domain'})${r?.id ? ` · Crustdata ID ${r.id} · resolved by ${r.method}${r.candidates > 1 ? ` from ${r.candidates} candidates` : ''}` : ''}`);
if (r?.why?.length) console.log(`  why: ${r.why.join('; ')}`);
console.log(`Extractor: ${out.extractor} · Judge: ${out.model} · ${out.claims.length} claims`);
console.log(`Score: ${summary.score}/100 · ${summary.counts.verified} verified, ${summary.counts.partially_verified} partly, ${summary.counts.contradicted} contradicted, ${summary.counts.unverifiable} unverifiable`);
for (const w of out.warnings) console.log(`⚠️  ${w}`);
for (const c of out.claims) {
  const v = out.results[c.id];
  console.log(`\n${ICON[v.verdict] ?? '?'} [slide ${c.slide} · ${c.category}] ${c.text}`);
  if (c.quote !== c.text) console.log(`   quote:    “${c.quote}”`);
  console.log(`   verdict:  ${v.verdict}`);
  console.log(`   reason:   ${v.reason}`);
  if (v.crustdata_value) console.log(`   value:    ${v.crustdata_value}`);
  for (const s of v.sources) {
    console.log(`   source:   ${s.label} · Crustdata ${s.endpoint}${s.url ? ` · ${s.url}` : ''}`);
    if (s.facts) console.log(`             evidence: ${JSON.stringify(s.facts).slice(0, 300)}`);
  }
}
