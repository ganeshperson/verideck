import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePptx, parseText, decodeXml } from '../lib/pptx.js';
import { analyzeSentence, extractClaims, splitSentences, detectCompany, buildClaim } from '../lib/claims.js';
import { deckScore } from '../lib/score.js';
import { verifyClaims, extractWithGemini } from '../lib/verify.js';
import { server } from '../server.js';

const sample = (f) => new URL(`../samples/${f}`, import.meta.url);
const sampleSlides = () => parseText(readFileSync(sample('sample.md'), 'utf8'));

// ---------- parsing & extraction ----------

test('parses pptx slides in presentation order, with notes', () => {
  const slides = parsePptx(readFileSync(sample('sample.pptx')));
  assert.equal(slides.length, 5);
  assert.match(slides[0].title, /^Retool/);
  assert.match(slides[2].notes[0], /crunchbase/);
  assert.ok(slides[4].lines.some((l) => l.includes('engineering & sales')), 'decodes XML entities');
});

test('rejects non-zip input', () => {
  assert.throws(() => parsePptx(Buffer.from('hello world, not a zip file at all')), /Not a ZIP/);
});

test('parses text decks split by ---', () => {
  const slides = parseText('# One\n- First point\n---\n## Two\n1. Second');
  assert.deepEqual(slides.map((s) => s.lines), [['One', 'First point'], ['Two', 'Second']]);
});

test('decodes numeric entities', () => {
  assert.equal(decodeXml('&#8220;hi&#x201D; &amp; &lt;b&gt;'), '“hi” & <b>');
});

test('splits sentences without breaking decimals or abbreviations', () => {
  assert.deepEqual(splitSentences('Growth was 3.5x vs. last year. Churn fell to 2%.'), ['Growth was 3.5x vs. last year.', 'Churn fell to 2%.']);
});

test('detects startup claim categories', () => {
  assert.deepEqual(analyzeSentence('We are a team of 40 engineers.'), ['headcount']);
  assert.deepEqual(analyzeSentence('We raised a $4M seed round led by Acme Ventures.'), ['funding']);
  assert.deepEqual(analyzeSentence('Founded in 2021 in Berlin.'), ['founded']);
  assert.ok(analyzeSentence('Our CTO was previously a staff engineer at Stripe.').includes('founder_background'));
  assert.ok(analyzeSentence('We are hiring 10 engineers this quarter.').includes('hiring'));
  assert.equal(analyzeSentence('Retool — Investor Update'), null);
  assert.equal(analyzeSentence('Thanks for listening, questions welcome.'), null);
});

test('detects the company from the deck', () => {
  assert.deepEqual(detectCompany(sampleSlides()), { name: 'Retool', domain: 'retool.com' });
  assert.equal(detectCompany(parseText('# Acme: Seed\nEmail us at hi@acme.io')).domain, null, 'ignores email domains');
  assert.equal(detectCompany(parseText('# Acme\nSee linkedin.com/company/acme and https://acme.ai')).domain, 'acme.ai', 'skips third-party sites');
});

test('heuristic extraction finds the sample claims', () => {
  const claims = extractClaims(sampleSlides());
  const cats = new Set(claims.map((c) => c.category));
  for (const c of ['headcount', 'funding', 'founded', 'founder_background', 'hiring']) assert.ok(cats.has(c), c);
});

test('score follows verdicts, user sources, and dismissals', () => {
  const claims = extractClaims(sampleSlides());
  const verified = Object.fromEntries(claims.map((c) => [c.id, { verification: { verdict: 'verified' } }]));
  const contradicted = Object.fromEntries(claims.map((c) => [c.id, { verification: { verdict: 'contradicted' } }]));
  assert.equal(deckScore(claims, verified).score, 100);
  assert.equal(deckScore(claims, contradicted).score, 0);
  assert.equal(deckScore(claims, contradicted).counts.flagged, claims.length);
  contradicted[claims[0].id] = { dismissed: true };
  assert.equal(deckScore(claims, contradicted).counts.dismissed, 1);
  assert.equal(deckScore([]).score, 100);
});

// ---------- Crustdata + Gemini pipeline (mocked HTTP) ----------

const COMPANY = {
  crustdata_company_id: 633593,
  updated_at: '2026-10-01T00:00:00Z',
  basic_info: { name: 'Retool', primary_domain: 'retool.com', website: 'https://retool.com/', year_founded: 2017, employee_count_range: '201-500', professional_network_url: 'https://www.linkedin.com/company/tryretool' },
  headcount: { total: 416, growth_percent: { yoy: -10.54 } },
  funding: { total_investment_usd: 141000000, last_round_type: 'series_c', last_fundraise_date: '2022-07-27', last_round_amount_usd: 45000000, investors: ['SV Angel', 'John Collison'] },
  hiring: { openings_count: 6 },
  people: { founders: [{ crustdata_person_id: 14540, basic_profile: { name: 'David Hsu', current_title: 'Founder, CEO' } }] },
};
const PERSON = {
  crustdata_person_id: 14540,
  basic_profile: { name: 'David Hsu' },
  social_handles: { professional_network_identifier: { profile_url: 'https://www.linkedin.com/in/dvdhsu' } },
  experience: { employment_details: { current: [{ name: 'Retool', title: 'Founder, CEO', start_date: '2017-01-01' }], past: [{ name: 'Palantir Technologies', title: 'Software Engineer' }] } },
};

function mockFetch(judge) {
  const calls = [];
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), headers: opts.headers ?? {}, body });
    if (String(url).startsWith('https://api.crustdata.com')) {
      assert.equal(opts.headers.authorization, 'Bearer cd-test');
      assert.equal(opts.headers['x-api-version'], '2025-11-01');
    }
    if (url.endsWith('/company/enrich')) return json([{ matched_on: 'retool.com', match_type: 'domain', matches: [{ confidence_score: 11, company_data: COMPANY }] }]);
    if (url.endsWith('/person/search')) return json({ profiles: [PERSON], total_count: 1 });
    if (url.endsWith('/web/search/live')) return json({ success: true, results: [{ source: 'web', title: 'Retool customers', url: 'https://retool.com/customers', snippet: 'Amazon and DoorDash build on Retool.' }] });
    if (url.includes('generativelanguage.googleapis.com')) {
      assert.equal(opts.headers['x-goog-api-key'], 'gm-test');
      const prompt = JSON.parse(body.contents[0].parts[0].text);
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(judge(prompt)) }] } }] });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { fn, calls };
}

async function withMocks(judge, run) {
  const real = globalThis.fetch;
  const mock = mockFetch(judge);
  process.env.CRUSTDATA_API_KEY = 'cd-test';
  process.env.GEMINI_API_KEY = 'gm-test';
  process.env.GEMINI_MODEL = 'gemini-test';
  globalThis.fetch = mock.fn;
  try {
    return await run(mock.calls);
  } finally {
    globalThis.fetch = real;
    delete process.env.CRUSTDATA_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  }
}

test('verifyClaims: Crustdata evidence → Gemini verdicts, each with reason and source', async () => {
  const slides = sampleSlides();
  const claims = extractClaims(slides);
  const byText = (t) => claims.find((c) => c.text.includes(t)).id;
  const headcount = byText('400+');
  const founder = byText('David Hsu');
  const customers = byText('Amazon');
  const hiring = byText('50 open roles');

  await withMocks(
    (p) => {
      assert.ok(p.evidence.some((e) => e.id === 'company.funding'));
      assert.ok(p.evidence.some((e) => e.id === 'person.14540'));
      return {
        verdicts: [
          { claim_id: headcount, verdict: 'verified', reason: 'Crustdata shows 416 employees, which meets 400+.', crustdata_value: 'headcount.total = 416', evidence_ids: ['company.headcount'] },
          { claim_id: founder, verdict: 'contradicted', reason: 'Past roles show Palantir, not Google.', crustdata_value: 'Software Engineer at Palantir', evidence_ids: ['person.14540'] },
          { claim_id: customers, verdict: 'verified', reason: 'Company site names both.', crustdata_value: '', evidence_ids: [`web.${customers}.0`] },
          // Claims a verdict without evidence: must be downgraded.
          { claim_id: hiring, verdict: 'contradicted', reason: 'Only 6 openings.', crustdata_value: 'openings_count = 6', evidence_ids: [] },
        ],
      };
    },
    async (calls) => {
      const out = await verifyClaims({ slides, claims, company: { name: 'Retool', domain: 'retool.com' }, founders: ['David Hsu'] });

      const enrich = calls.find((c) => c.url.endsWith('/company/enrich'));
      assert.deepEqual(enrich.body.domains, ['retool.com']);
      assert.ok(enrich.body.fields.includes('funding'));
      assert.ok(!enrich.body.fields.includes('people'), 'people is fetched separately (slow for big companies)');
      const searches = calls.filter((c) => c.url.endsWith('/person/search')).map((c) => c.body.filters);
      assert.ok(searches.some((f) => JSON.stringify(f) === JSON.stringify({ field: 'crustdata_person_id', type: 'in', value: [14540] })));
      assert.ok(calls.some((c) => c.url.endsWith('/web/search/live')));

      assert.equal(out.company.headcount, 416);
      assert.equal(out.company.total_funding, '$141M');
      assert.equal(out.results[headcount].verdict, 'verified');
      assert.equal(out.results[headcount].sources[0].endpoint, 'POST /company/enrich');
      assert.equal(out.results[founder].verdict, 'contradicted');
      assert.equal(out.results[founder].sources[0].url, 'https://www.linkedin.com/in/dvdhsu');
      assert.equal(out.results[customers].sources[0].url, 'https://retool.com/customers');
      assert.equal(out.results[hiring].verdict, 'unverifiable');
      assert.match(out.results[hiring].reason, /Downgraded/);

      for (const c of claims) {
        const r = out.results[c.id];
        assert.ok(r.reason, `reason for ${c.text}`);
        assert.ok(r.sources.length, `source for ${c.text}`);
      }
    }
  );
});

test('verifyClaims: unknown company yields unverifiable verdicts that cite the Crustdata lookup', async () => {
  const slides = parseText('# Nopeco\nFounded in 2020.');
  const claims = [buildClaim(slides[0], 'Founded in 2020.', 'founded')];
  const real = globalThis.fetch;
  process.env.CRUSTDATA_API_KEY = 'cd-test';
  process.env.GEMINI_API_KEY = 'gm-test';
  process.env.GEMINI_MODEL = 'gemini-test';
  globalThis.fetch = async (url) => {
    if (url.endsWith('/company/enrich')) return new Response(JSON.stringify([{ matched_on: 'Nopeco', matches: [] }]));
    if (url.endsWith('/web/search/live')) return new Response(JSON.stringify({ results: [] }));
    throw new Error('Gemini should not be called without evidence: ' + url);
  };
  try {
    const out = await verifyClaims({ slides, claims, company: { name: 'Nopeco' } });
    const r = out.results[claims[0].id];
    assert.equal(r.verdict, 'unverifiable');
    assert.match(r.reason, /No Crustdata company record/);
    assert.ok(r.sources.some((s) => s.endpoint === 'POST /company/enrich'));
    assert.ok(out.warnings.some((w) => /no company matching/.test(w)));
  } finally {
    globalThis.fetch = real;
    delete process.env.CRUSTDATA_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  }
});

test('Gemini extraction: atomic claims, real slides only, pattern matching fills gaps', async () => {
  const slides = parseText('# Acme\nacme.io\n---\nFounded in 2019 by Jane Doe, ex-Stripe.\n---\nWe are a team of 40 people.');
  const real = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'gm-test';
  process.env.GEMINI_MODEL = 'gemini-test';
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(url.includes('/models/gemini-test:generateContent'));
    const out = {
      company: { name: 'Acme', domain: 'https://www.acme.io/', hq_city: '' },
      founders: ['Jane Doe'],
      claims: [
        { slide: 2, quote: 'Founded in 2019 by Jane Doe, ex-Stripe.', claim: 'Acme was founded in 2019.', category: 'founded' },
        { slide: 2, quote: 'Founded in 2019 by Jane Doe, ex-Stripe.', claim: 'Jane Doe previously worked at Stripe.', category: 'founder_background' },
        { slide: 99, quote: 'Ghost.', claim: 'Ghost slide claim.', category: 'other' },
        // Gemini "forgot" the headcount sentence on slide 3.
      ],
    };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }));
  };
  try {
    const r = await extractWithGemini(slides);
    const byCat = Object.groupBy(r.claims, (c) => c.category);
    assert.equal(byCat.founded.length, 1, 'no duplicate founded claim from pattern matching');
    assert.equal(byCat.founded[0].text, 'Acme was founded in 2019.');
    assert.equal(byCat.founded[0].quote, 'Founded in 2019 by Jane Doe, ex-Stripe.');
    assert.equal(byCat.founder_background.length, 1);
    assert.equal(byCat.headcount?.length, 1, 'pattern matching adds the claim Gemini missed');
    assert.equal(byCat.headcount[0].extractedBy, 'pattern');
    assert.ok(!r.claims.some((c) => c.text.includes('Ghost')));
    assert.equal(r.company.domain, 'acme.io');
    assert.deepEqual(r.founders, ['Jane Doe']);
  } finally {
    globalThis.fetch = real;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  }
});

test('pattern extraction splits multi-fact sentences into one claim per category', () => {
  const claims = extractClaims(parseText('Founded in 2019 by ex-Google engineers Jane Doe and John Roe.'));
  assert.deepEqual(claims.map((c) => c.category).sort(), ['founded', 'founder_background']);
  assert.notEqual(claims[0].id, claims[1].id);
  assert.equal(claims[0].sentenceId, claims[1].sentenceId);
});

test('company resolution picks the namesake that fits the pitch', async () => {
  const { resolveCompany, pitchHints } = await import('../lib/verify.js');
  const real = globalThis.fetch;
  process.env.CRUSTDATA_API_KEY = 'cd-test';
  const cand = (id, domain, year, size) => ({ confidence_score: 1, company_data: { crustdata_company_id: id, basic_info: { name: 'Zepto', primary_domain: domain, year_founded: year, employee_count_range: size } } });
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/company/identify')) {
      assert.deepEqual(body, { names: ['Zepto'] });
      return new Response(JSON.stringify([{ matches: [cand(2, 'zepto.com.au', 2018, '51-200'), cand(1, 'zepto.com', 2021, '5001-10000'), cand(3, 'zepto.io', 2016, '11-50')] }]));
    }
    // Tie-break lookups (HQ / founders) are optional; answer empty.
    if (url.endsWith('/company/enrich')) return new Response(JSON.stringify([{ matches: [] }]));
    if (url.endsWith('/person/search')) return new Response(JSON.stringify({ profiles: [] }));
    throw new Error('unexpected ' + url);
  };
  try {
    const slides = parseText('# Zepto\nFounded in 2021. We are a team of 5,000+ people.');
    const hints = pitchHints(extractClaims(slides), { name: 'Zepto' });
    assert.equal(hints.year_founded, 2021);
    assert.equal(hints.headcount, 5000);
    const r = await resolveCompany(hints);
    assert.equal(r.id, 1);
    assert.equal(r.domain, 'zepto.com');
    assert.equal(r.candidates, 3);
    assert.ok(r.why.some((w) => w.includes('2021')));
  } finally {
    globalThis.fetch = real;
    delete process.env.CRUSTDATA_API_KEY;
  }
});

// ---------- HTTP ----------

test('HTTP API: analyze, verify guard, static files', async () => {
  delete process.env.CRUSTDATA_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const pptx = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'sample.pptx' },
      body: readFileSync(sample('sample.pptx')),
    }).then((r) => r.json());
    assert.equal(pptx.deck.slides.length, 5);
    assert.equal(pptx.extractor, 'heuristic');
    assert.deepEqual(pptx.company, { name: 'Retool', domain: 'retool.com' });
    assert.ok(pptx.claims.length >= 5);

    const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
    assert.deepEqual([cfg.crustdata, cfg.gemini, cfg.crustdataVersion], [false, false, '2025-11-01']);

    const verify = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claims: pptx.claims, company: pptx.company }),
    });
    assert.equal(verify.status, 503);
    assert.match((await verify.json()).error, /CRUSTDATA_API_KEY and GEMINI_API_KEY/);

    const check = await fetch(`${base}/api/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Zepto was founded in 2021 by Aadit Palicha.' }),
    }).then((r) => r.json());
    assert.ok(check.claims.length >= 2, 'founded + founder claims');
    assert.deepEqual(check.results, {});
    assert.ok(check.warnings.some((w) => /Not verified: add CRUSTDATA_API_KEY and GEMINI_API_KEY/.test(w)));

    const replay = await fetch(`${base}/api/replay`);
    if (replay.status === 200) {
      const r = await replay.json();
      assert.equal(r.replay, true);
      assert.ok(r.claims.length && Object.keys(r.results).length, 'saved run has claims and verdicts');
    } else {
      assert.equal(replay.status, 404);
      assert.match((await replay.json()).error, /No saved run yet/);
    }

    const bad = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'x-filename': 'deck.key' }, body: 'x' });
    assert.equal(bad.status, 415);

    assert.match(await fetch(base).then((r) => r.text()), /VeriDeck/);
    assert.equal((await fetch(`${base}/shared/score.js`)).status, 200);
    assert.equal((await fetch(`${base}/shared/..%2fserver.js`)).status, 403);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  } finally {
    server.close();
  }
});

test('Gemini falls back to the next model when one is overloaded', async () => {
  const real = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'gm-test';
  const tried = [];
  globalThis.fetch = async (url) => {
    if (url.includes('/models?')) {
      return new Response(JSON.stringify({ models: ['gemini-9.1-flash', 'gemini-9.0-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }));
    }
    const model = url.match(/models\/([^:]+):/)[1];
    tried.push(model);
    if (model === 'gemini-9.1-flash') return new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
  };
  try {
    const { generateJson, geminiModel } = await import('../lib/gemini.js');
    assert.deepEqual(await generateJson({ system: 's', prompt: 'p', schema: { type: 'OBJECT' } }), { ok: true });
    assert.deepEqual(tried, ['gemini-9.1-flash', 'gemini-9.1-flash', 'gemini-9.0-flash']);
    assert.equal(await geminiModel(), 'gemini-9.0-flash');
    tried.length = 0;
    await generateJson({ system: 's', prompt: 'p', schema: { type: 'OBJECT' } });
    assert.deepEqual(tried, ['gemini-9.0-flash'], 'remembers the model that worked');
  } finally {
    globalThis.fetch = real;
    delete process.env.GEMINI_API_KEY;
  }
});

test('founder questions: contradicted first, then weakest by stakes; skips handled claims', async () => {
  const { founderQuestions } = await import('../lib/questions.js');
  const slides = parseText('# Acme\nWe are a team of 50 engineers.\nWe raised $10M from Sequoia.\nFounded in 2019.\nWe are hiring 20 engineers.');
  const claims = extractClaims(slides);
  const id = (cat) => claims.find((c) => c.category === cat).id;
  const src = [{ label: 'Headcount', endpoint: 'POST /company/enrich', url: 'https://x.test' }];
  const states = {
    [id('headcount')]: { verification: { verdict: 'contradicted', reason: 'Only 12 people.', crustdata_value: 'headcount.total = 12', sources: src } },
    [id('funding')]: { verification: { verdict: 'unverifiable', reason: 'No funding data.', crustdata_value: '', sources: src } },
    [id('founded')]: { verification: { verdict: 'verified', reason: 'ok', crustdata_value: '2019', sources: src } },
    [id('hiring')]: { verification: { verdict: 'contradicted', reason: '2 openings.', crustdata_value: 'openings_count = 2', sources: src } },
  };
  const qs = founderQuestions(claims, states);
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map((q) => q.verdict), ['contradicted', 'contradicted', 'unverifiable']);
  assert.match(qs[0].question, /but Crustdata shows/);
  assert.ok(qs.every((q) => q.source?.endpoint));
  assert.ok(!qs.some((q) => q.claimId === id('founded')), 'verified claims are not questioned');

  states[id('hiring')].sources = [{ url: 'https://jobs.acme.test' }];
  assert.ok(!founderQuestions(claims, states).some((q) => q.claimId === id('hiring')), 'claims the user sourced are skipped');
});

test('recommendation: thresholds, contradiction rules, precedence', async () => {
  const { recommendation } = await import('../lib/recommendation.js');
  const slides = parseText('# Acme\nWe raised $10M from Sequoia.\nFounded by Jane Doe, ex-Stripe.\nWe are a team of 50 engineers.\nWe are hiring 20 engineers.\nFounded in 2019.');
  const claims = extractClaims(slides).filter((c, i, all) => all.findIndex((x) => x.category === c.category) === i);
  const id = (cat) => claims.find((c) => c.category === cat).id;
  const set = (verdicts) => Object.fromEntries(claims.map((c) => [c.id, { verification: { verdict: verdicts[c.category] ?? 'verified', reason: 'r', sources: [] } }]));

  assert.equal(recommendation(claims, {}), null, 'no badge before verification');

  let r = recommendation(claims, set({}));
  assert.equal(r.decision, 'take');
  assert.match(r.reason, /no claim contradicted/);

  r = recommendation(claims, set({ funding: 'contradicted' }));
  assert.equal(r.decision, 'dig', 'contradicted funding blocks "Take the meeting"');
  assert.match(r.reason, /funding claim was contradicted/);

  r = recommendation(claims, set({ founder_background: 'contradicted' }));
  assert.equal(r.decision, 'dig');
  assert.match(r.reason, /founder claim was contradicted/);

  r = recommendation(claims, set({ hiring: 'contradicted', founded: 'contradicted' }));
  assert.equal(r.decision, 'pass', '2+ contradictions');
  assert.match(r.reason, /^2 claims contradicted/);

  r = recommendation(claims, set({ funding: 'unverifiable', founder_background: 'unverifiable', headcount: 'unverifiable', hiring: 'unverifiable' }));
  assert.ok(r.score < 40);
  assert.equal(r.decision, 'pass');
  assert.match(r.reason, /below 40/);

  r = recommendation(claims, set({ funding: 'partially_verified', headcount: 'unverifiable', hiring: 'unverifiable' }));
  assert.ok(r.score >= 40 && r.score < 75, `score ${r.score}`);
  assert.equal(r.decision, 'dig');
  assert.match(r.reason, /between 40 and 74/);

  // A contradiction the user backed with their own source doesn't count.
  const states = set({ hiring: 'contradicted', founded: 'contradicted' });
  states[id('hiring')].sources = [{ url: 'https://jobs.acme.test' }];
  assert.notEqual(recommendation(claims, states).decision, 'pass');
});
