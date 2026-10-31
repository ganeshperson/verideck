// Verification pipeline: gather evidence from Crustdata, then have Gemini judge
// each claim strictly against that evidence. Every verdict carries a reason and
// at least one source.
import { companyPeople, enrichCompany, foundersAtCompany, identifyCompany, peopleById, peopleByNameAtCompany, webSearch } from './crustdata.js';
import { generateJson, geminiModel } from './gemini.js';
import { CATEGORIES, buildClaim, detectCompany, extractClaims, mergeClaims } from './claims.js';

const MAX_WEB_SEARCHES = 6; // Crustdata web search allows 10 requests/minute
const WEB_CATEGORIES = new Set(['other', 'growth']);

const usd = (n) =>
  typeof n === 'number'
    ? n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString('en-US')}`
    : null;
const day = (d) => (d ? String(d).slice(0, 10) : null);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));

// ---------- claim extraction (Gemini, with heuristic fallback) ----------

const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    company: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        domain: { type: 'STRING', description: 'Website domain like acme.com if it appears in the deck, else empty' },
        hq_city: { type: 'STRING', description: 'Headquarters city if stated, else empty' },
      },
      required: ['name', 'domain', 'hq_city'],
    },
    founders: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Full names of every founder mentioned' },
    claims: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          slide: { type: 'INTEGER' },
          quote: { type: 'STRING', description: 'The sentence the claim comes from, copied verbatim' },
          claim: { type: 'STRING', description: 'One self-contained checkable fact, e.g. "Zepto was founded in 2021"' },
          category: { type: 'STRING', enum: Object.keys(CATEGORIES) },
        },
        required: ['slide', 'quote', 'claim', 'category'],
      },
    },
  },
  required: ['company', 'founders', 'claims'],
};

const EXTRACT_SYSTEM = `You read startup pitch decks and list EVERY factual claim about the company and its founders that could be checked against company, people, or web data.
Categories: headcount (team size), funding (amounts, rounds, investors, accelerators, valuation), founded (founding year), founder_background (who the founders are, and their past employers, roles, and schools), hiring (open roles, hiring plans), location (HQ, offices, cities served), growth (growth rates), other (product facts such as delivery times, customers, revenue, users, partnerships, rankings, and any other checkable fact).
Rules:
- Be exhaustive. Recall matters more than precision: when unsure whether something is checkable, include it.
- Split compound sentences into atomic claims, one fact each. "Founded in 2021 in Mumbai by A and B, ex-Stripe" is four claims: founded year, HQ city, who the founders are, and the founders' past employer.
- Write each claim as a self-contained sentence that names the company.
- Include facts in the title slide, taglines ("groceries in 10 minutes" is a product claim), and speaker notes.
- Skip only pure opinion and vision with nothing checkable ("we will change the world").
- Use the slide numbers given.`;

const deckText = (slides) =>
  slides
    .map((s) => `[Slide ${s.index}]\n${s.lines.join('\n')}${s.notes.length ? `\n(Speaker notes: ${s.notes.join(' ')})` : ''}`)
    .join('\n\n');

export async function extractWithGemini(slides) {
  const out = await generateJson({ system: EXTRACT_SYSTEM, prompt: deckText(slides), schema: EXTRACT_SCHEMA });
  const bySlide = new Map(slides.map((s) => [s.index, s]));
  const seen = new Set();
  const claims = [];
  for (const c of out.claims ?? []) {
    const slide = bySlide.get(c.slide);
    const text = (c.claim || c.quote || c.text || '').trim();
    if (!slide || !text) continue;
    const claim = buildClaim(slide, text, c.category, { quote: (c.quote || text).trim(), extractedBy: 'gemini' });
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    claims.push(claim);
  }
  const fallback = detectCompany(slides);
  return {
    // Pattern matching backs Gemini up: anything it skipped is added back.
    claims: mergeClaims(claims, extractClaims(slides)),
    company: {
      name: out.company?.name?.trim() || fallback.name,
      domain: cleanDomain(out.company?.domain) || fallback.domain,
      hq_city: out.company?.hq_city?.trim() || null,
    },
    founders: (out.founders ?? []).map((f) => f.trim()).filter(Boolean),
  };
}

const cleanDomain = (d) => d?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;

export function extractHeuristic(slides) {
  const claims = extractClaims(slides);
  // Founder names from "founded by A and B" style sentences.
  const founders = [];
  for (const c of claims.filter((x) => x.category === 'founder_background')) {
    const m = c.quote.match(/founded by ([A-Z][\w'-]+(?: [A-Z][\w'-]+)+)(?:,? and ([A-Z][\w'-]+(?: [A-Z][\w'-]+)+))?/);
    if (m) founders.push(...[m[1], m[2]].filter(Boolean));
  }
  return { claims, company: detectCompany(slides), founders: [...new Set(founders)] };
}

// ---------- company resolution ----------

const normName = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|ltd|limited|pvt|private|corp|co|technologies|technology)\b/g, '').trim();

function rangeOf(r) {
  const m = String(r ?? '').match(/(\d[\d,]*)\D+(\d[\d,]*)/);
  if (m) return [+m[1].replace(/,/g, ''), +m[2].replace(/,/g, '')];
  const plus = String(r ?? '').match(/(\d[\d,]*)\+/);
  return plus ? [+plus[1].replace(/,/g, ''), Infinity] : null;
}

// What the pitch itself says, used to tell same-named companies apart.
export function pitchHints(claims, company = {}, founders = []) {
  const year = claims.filter((c) => c.category === 'founded').map((c) => c.text.match(/\b(19|20)\d{2}\b/)?.[0]).find(Boolean);
  const head = claims
    .filter((c) => c.category === 'headcount')
    .map((c) => c.text.replace(/,/g, '').match(/\b(\d{1,6})\b(?!\s*%)/)?.[1])
    .find(Boolean);
  return compact({
    name: company.name,
    domain: cleanDomain(company.domain),
    year_founded: year ? Number(year) : null,
    headcount: head ? Number(head) : null,
    hq_city: company.hq_city || claims.filter((c) => c.category === 'location').map((c) => c.text)[0] || null,
    founders,
  });
}

function scoreCandidate(c, hints) {
  const why = [];
  let score = c.confidence * 10;
  if (hints.name && normName(c.name) === normName(hints.name)) (score += 4), why.push('exact name');
  if (hints.domain && [c.primary_domain, ...(c.all_domains ?? [])].filter(Boolean).some((d) => cleanDomain(d) === hints.domain)) (score += 20), why.push('domain matches pitch');
  if (hints.year_founded && c.year_founded) {
    const off = Math.abs(c.year_founded - hints.year_founded);
    if (off === 0) (score += 8), why.push(`founded ${c.year_founded} matches`);
    else if (off === 1) score += 3;
    else (score -= 5), why.push(`founded ${c.year_founded} ≠ ${hints.year_founded}`);
  }
  const range = rangeOf(c.employee_count_range);
  if (hints.headcount && range) {
    if (hints.headcount >= range[0] * 0.5 && hints.headcount <= range[1] * 1.5) (score += 4), why.push(`size ${c.employee_count_range} fits`);
    else score -= 3;
  }
  // Weak tie-breaker: a company pitching with checkable traction is rarely the tiny namesake.
  if (range) score += Math.min(Math.log10(Math.max(range[1], 1)), 5) * 0.4;
  return { score, why };
}

export async function resolveCompany(hints) {
  if (!hints.name && !hints.domain) return null;
  let candidates = [];
  let method = 'name';
  if (hints.domain) {
    candidates = await identifyCompany({ domain: hints.domain });
    method = 'domain';
  }
  if (!candidates.length && hints.name) {
    candidates = await identifyCompany({ name: hints.name });
    method = 'name';
  }
  if (!candidates.length) return { id: null, name: hints.name, domain: hints.domain ?? null, method, candidates: 0, alternatives: [], why: ['no Crustdata match'] };

  let ranked = candidates.slice(0, 25).map((c) => ({ ...c, ...scoreCandidate(c, hints) })).sort((a, b) => b.score - a.score);

  // Still close? Compare HQ and founders on the top few full profiles.
  if (method === 'name' && ranked.length > 1 && ranked[0].score - ranked[1].score < 6 && (hints.hq_city || hints.founders?.length)) {
    const top = ranked.slice(0, 3);
    const profiles = await Promise.all(top.map((c) => enrichCompany({ id: c.id }).catch(() => null)));
    top.forEach((c, i) => {
      const p = profiles[i];
      if (!p) return;
      const hq = JSON.stringify(p.locations ?? {}).toLowerCase();
      const city = normName(hints.hq_city).split(' ').find((w) => w.length > 3);
      if (city && hq.includes(city)) (c.score += 8), c.why.push(`HQ ${city} matches`);
      c.profile = p;
    });
    if (hints.founders?.length) {
      const found = await Promise.all(top.map((c) => (c.primary_domain ? peopleByNameAtCompany(hints.founders, { domain: c.primary_domain }).catch(() => []) : [])));
      top.forEach((c, i) => {
        const hits = [...new Set(found[i].map((p) => p.basic_profile?.name).filter(Boolean))];
        if (hits.length) (c.score += 6 * hits.length), c.why.push(`founders ${hits.join(', ')} work there`);
      });
    }
    ranked = [...top.sort((a, b) => b.score - a.score), ...ranked.slice(3)];
  }

  const pick = ranked[0];
  return {
    id: pick.id,
    name: pick.name,
    domain: pick.primary_domain ?? null,
    website: pick.website ?? null,
    profile_url: pick.professional_network_url ?? null,
    method,
    candidates: candidates.length,
    margin: ranked[1] ? +(pick.score - ranked[1].score).toFixed(1) : null,
    why: pick.why,
    alternatives: ranked.slice(1, 4).map((c) => compact({ name: c.name, domain: c.primary_domain, year_founded: c.year_founded, employee_count_range: c.employee_count_range })),
    profile: pick.profile ?? null, // full enrich, when fetched during tie-breaking
  };
}

// ---------- evidence from Crustdata ----------

function companyEvidence(cd, retrievedAt) {
  const b = cd.basic_info ?? {};
  const h = cd.headcount ?? {};
  const f = cd.funding ?? {};
  const hire = cd.hiring ?? {};
  const loc = cd.locations ?? {};
  const social = cd.social_profiles ?? {};
  const profileUrl = b.professional_network_url || social.professional_network?.url || social.professional_network || null;
  const crunchbase = social.crunchbase?.url ?? null;
  const base = { endpoint: 'POST /company/enrich', retrieved_at: retrievedAt, data_updated_at: cd.updated_at ?? null };
  const ev = [];

  ev.push({
    ...base,
    id: 'company.basic_info',
    label: 'Company record',
    url: b.website || (b.primary_domain ? `https://${b.primary_domain}` : null),
    facts: compact({
      name: b.name,
      primary_domain: b.primary_domain,
      year_founded: b.year_founded,
      employee_count_range: b.employee_count_range,
      company_type: b.company_type,
      status: b.status,
    }),
  });
  if (cd.headcount) {
    ev.push({
      ...base,
      id: 'company.headcount',
      label: 'Headcount',
      url: profileUrl,
      facts: compact({ total: h.total, growth_percent: h.growth_percent, growth_absolute: h.growth_absolute, by_role_absolute: h.by_role_absolute }),
    });
  }
  if (cd.funding) {
    ev.push({
      ...base,
      id: 'company.funding',
      label: 'Funding',
      url: crunchbase || profileUrl || b.website || null,
      facts: compact({
        total_investment_usd: f.total_investment_usd,
        last_round_type: f.last_round_type,
        last_round_amount_usd: f.last_round_amount_usd,
        last_fundraise_date: f.last_fundraise_date,
        investors: f.investors?.slice(0, 40),
        funding_rounds: f.funding_rounds?.slice?.(0, 20),
        acquisitions: f.acquisitions?.slice?.(0, 10),
      }),
    });
  }
  if (cd.hiring) {
    ev.push({
      ...base,
      id: 'company.hiring',
      label: 'Hiring',
      url: profileUrl ? `${profileUrl.replace(/\/$/, '')}/jobs` : null,
      facts: compact({
        openings_count: hire.openings_count,
        openings_growth_percent: hire.openings_growth_percent,
        recent_openings: hire.recent_openings?.slice?.(0, 25),
      }),
    });
  }
  if (cd.locations) {
    ev.push({
      ...base,
      id: 'company.locations',
      label: 'Locations',
      url: profileUrl,
      facts: compact({ headquarters: loc.headquarters, country: loc.country, state: loc.state, offices: loc.all_office_addresses?.slice?.(0, 10) }),
    });
  }
  if (cd.people) ev.push(peopleEvidence(cd, retrievedAt));
  return ev;
}

function peopleEvidence(cd, retrievedAt) {
  const people = cd.people ?? {};
  const listed = [...(people.founders ?? []), ...(people.cxos ?? [])].map((p) =>
    compact({ name: p.basic_profile?.name ?? p.name, title: p.basic_profile?.current_title ?? p.title })
  );
  return {
    id: 'company.people',
    label: 'Founders and executives',
    endpoint: 'POST /company/enrich',
    retrieved_at: retrievedAt,
    data_updated_at: cd.updated_at ?? null,
    url: cd.basic_info?.professional_network_url ?? null,
    facts: { founders_and_cxos: listed },
  };
}

function personEvidence(profile, retrievedAt, i) {
  const emp = profile.experience?.employment_details ?? {};
  const role = (r) => compact({ company: r.name ?? r.company_name, title: r.title, start: day(r.start_date), end: day(r.end_date) });
  const name = profile.basic_profile?.name ?? `Person ${profile.crustdata_person_id}`;
  return {
    id: `person.${profile.crustdata_person_id ?? i}`,
    label: `${name}: employment history`,
    endpoint: 'POST /person/search',
    retrieved_at: retrievedAt,
    url: profile.social_handles?.professional_network_identifier?.profile_url ?? null,
    facts: compact({
      name,
      headline: profile.basic_profile?.headline,
      current_roles: (emp.current ?? []).map(role),
      past_roles: (emp.past ?? []).slice(0, 20).map(role),
      education: (profile.education?.schools ?? []).map((s) => compact({ school: s.school, degree: s.degree, field: s.field_of_study })),
    }),
  };
}

function founderIds(cd) {
  const people = cd?.people ?? {};
  const ids = new Set();
  for (const p of people.founders ?? []) if (p.crustdata_person_id) ids.add(p.crustdata_person_id);
  for (const p of people.cxos ?? []) {
    if (p.crustdata_person_id && /founder/i.test(p.basic_profile?.current_title ?? p.title ?? '')) ids.add(p.crustdata_person_id);
  }
  return [...ids].slice(0, 25);
}

export function companySnapshot(cd) {
  if (!cd) return null;
  const b = cd.basic_info ?? {};
  const f = cd.funding ?? {};
  return compact({
    crustdata_company_id: cd.crustdata_company_id,
    name: b.name,
    domain: b.primary_domain,
    website: b.website,
    profile_url: b.professional_network_url,
    crunchbase_url: cd.social_profiles?.crunchbase?.url,
    year_founded: b.year_founded,
    headcount: cd.headcount?.total,
    employee_count_range: b.employee_count_range,
    headcount_yoy_percent: cd.headcount?.growth_percent?.yoy,
    total_funding: usd(f.total_investment_usd),
    last_round: [f.last_round_type?.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()), usd(f.last_round_amount_usd), day(f.last_fundraise_date)].filter(Boolean).join(' · ') || null,
    investors: f.investors?.slice(0, 8),
    open_roles: cd.hiring?.openings_count,
    headquarters: typeof cd.locations?.headquarters === 'string' ? cd.locations.headquarters : cd.locations?.country,
    founders: (cd.people?.founders ?? []).map((p) => p.basic_profile?.name).filter(Boolean),
    updated_at: day(cd.updated_at),
  });
}

// ---------- judging ----------

const VERDICT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          claim_id: { type: 'STRING' },
          verdict: { type: 'STRING', enum: ['verified', 'partially_verified', 'contradicted', 'unverifiable'] },
          reason: { type: 'STRING', description: 'One or two sentences comparing the claim with the evidence, quoting the numbers.' },
          crustdata_value: { type: 'STRING', description: 'The specific value(s) from the evidence that decided the verdict, or empty.' },
          evidence_ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'IDs of the evidence items used. Required unless unverifiable.' },
        },
        required: ['claim_id', 'verdict', 'reason', 'crustdata_value', 'evidence_ids'],
      },
    },
  },
  required: ['verdicts'],
};

const JUDGE_SYSTEM = `You fact-check startup pitch claims using ONLY the Crustdata evidence provided. Never use outside knowledge.
Verdicts:
- verified: the evidence clearly supports the claim.
- partially_verified: roughly right but off in a detail (amount, date, rounding, an investor or employer not listed).
- contradicted: the evidence conflicts with the claim.
- unverifiable: the evidence does not cover the claim.
Guidelines:
- Headcount: within ±20% of headcount.total is verified; "X+" claims are verified when the total is at least X. Crustdata counts employees with public professional profiles, so modest undercounts are normal; say so in the reason.
- Founded year: exact match is verified; off by one year is partially_verified.
- Funding: compare amounts with total_investment_usd, last_round_amount_usd, and funding_rounds (±10% is fine), and round types and dates. Check named investors against the investor list.
- Founder identity ("founded by A and B"): verified when each named person appears in the company's founders_and_cxos list or has a current or past role at the company with a founder title. Match names loosely (case, middle names, abbreviated surnames like "Anthony G."). If only some are confirmed, partially_verified, and name who is missing.
- Founder background: match past employers, titles, and schools against past_roles, current_roles, and education (ignore suffixes like Inc. or LLC). Missing history is unverifiable, not contradicted.
- Location: compare with headquarters, country, and offices. The same city under another name (Bombay/Mumbai, Bengaluru/Bangalore) counts as a match.
- Product facts (delivery times, features, customers): use web results.
- Contradicted needs evidence that actually conflicts. Missing or silent evidence means unverifiable.
- Hiring: compare with openings_count and recent_openings.
- Web results support a claim only when the snippet states it outright, preferably from the company itself or a reputable outlet. Any evidence item can support any claim; for_claim only records which search found it.
Each claim also has a quote, the slide sentence it came from, for context; judge the claim itself.
Always cite the evidence IDs you used. Quote the specific numbers in the reason.`;

export async function verifyClaims({ slides, claims, company, founders = [], profile = null, onProgress = () => {} }) {
  const retrievedAt = new Date().toISOString();
  const warnings = [];
  const evidence = [];
  const lookups = []; // what was queried, used as the source when nothing matched

  // 1. Company record (by resolved Crustdata ID when we have one)
  let cd = null;
  if (company?.id || company?.domain || company?.name) {
    onProgress({ step: 'company', message: `Fetching ${company.name || company.domain} from Crustdata…` });
    cd = profile ?? (await enrichCompany(company));
    lookups.push({
      id: 'lookup.company',
      label: cd ? `Crustdata company record for ${cd.basic_info?.name ?? company.name}` : `No Crustdata company record for ${company.domain || company.name}`,
      endpoint: 'POST /company/enrich',
      retrieved_at: retrievedAt,
      url: null,
      facts: { query: compact({ crustdata_company_id: company.id, domain: company.domain, name: company.name }), matched: Boolean(cd) },
    });
    if (cd) evidence.push(...companyEvidence(cd, retrievedAt));
    else warnings.push(`Crustdata has no company matching ${company.domain || company.name}. Check the company name and domain.`);
  } else {
    warnings.push('Could not tell which company this deck is about. Set the company name or domain and verify again.');
  }

  // 2 + 3 in parallel: founders' profiles, and web search for claims the datasets don't cover
  onProgress({ step: 'people', message: 'Looking up founders and searching the web…' });
  const companyName = cd?.basic_info?.name ?? company?.name ?? '';
  const needsPeople = claims.some((c) => c.category === 'founder_background');
  const webPool = claims.filter((c) => !cd || WEB_CATEGORIES.has(c.category));
  const webTargets = webPool.slice(0, MAX_WEB_SEARCHES);
  if (webPool.length > MAX_WEB_SEARCHES) {
    warnings.push(`Web-searched the first ${MAX_WEB_SEARCHES} claims that need it (Crustdata web search is rate limited).`);
  }

  const peopleTask = (async () => {
    if (!cd) return;
    // Company people section (founders/CXOs): slow for big companies, so time-boxed.
    let people = cd.people ?? null;
    if (!people && cd.crustdata_company_id) {
      people = await companyPeople(cd.crustdata_company_id).catch((err) => {
        console.log(`[verify] people section skipped: ${err.message}`);
        return null;
      });
      if (people) {
        cd.people = people;
        evidence.push(peopleEvidence(cd, retrievedAt));
      }
    }
    if (!(needsPeople || founders.length)) return;
    const domain = cd.basic_info?.primary_domain;
    const [byId, byName, byTitle] = await Promise.all([
      peopleById(founderIds(cd)),
      founders.length ? peopleByNameAtCompany(founders, domain ? { domain } : { name: companyName }) : [],
      founders.length || founderIds(cd).length ? [] : foundersAtCompany(domain),
    ]);
    const profiles = [];
    const seen = new Set();
    for (const p of [...byId, ...byName, ...byTitle]) {
      const key = p.crustdata_person_id ?? normName(p.basic_profile?.name);
      if (seen.has(key)) continue;
      seen.add(key);
      profiles.push(p);
    }
    profiles.forEach((p, i) => evidence.push(personEvidence(p, retrievedAt, i)));
    lookups.push({
      id: 'lookup.people',
      label: profiles.length ? `Crustdata people search: ${profiles.length} founder profile(s)` : 'Crustdata people search found no founder profiles',
      endpoint: 'POST /person/search',
      retrieved_at: retrievedAt,
      url: null,
      facts: { founder_ids: founderIds(cd), names_searched: founders },
    });
  })().catch((err) => warnings.push(`Founder lookup failed: ${err.message}`));

  const searched = new Set();
  const searchWeb = (targets) =>
    Promise.all(
      targets.map(async (c) => {
        searched.add(c.id);
        const query = `${companyName && !c.text.toLowerCase().includes(companyName.toLowerCase()) ? `${companyName} ` : ''}${c.text}`.slice(0, 200);
        try {
          const results = await webSearch(query);
          results.forEach((r, i) =>
            evidence.push({
              id: `web.${c.id}.${i}`,
              label: r.title || r.url,
              endpoint: 'POST /web/search/live',
              retrieved_at: retrievedAt,
              url: r.url,
              facts: compact({ for_claim: c.id, title: r.title, snippet: r.snippet, source: r.source, date: r.date }),
            })
          );
          lookups.push({ id: `lookup.web.${c.id}`, label: `Crustdata web search: “${query}”`, endpoint: 'POST /web/search/live', retrieved_at: retrievedAt, url: null, facts: { query, results: results.length } });
        } catch (err) {
          warnings.push(`Web search failed for one claim: ${err.message}`);
        }
      })
    );
  const webTask = searchWeb(webTargets);
  await Promise.all([peopleTask, webTask]);
  onProgress({ step: 'judge', message: `Gemini is judging ${claims.length} claims against ${evidence.length} pieces of Crustdata evidence…` });

  // 4. Gemini judges each claim against the evidence
  const judge = async (subset) => {
    if (!evidence.length || !subset.length) return [];
    const prompt = JSON.stringify(
      {
        company: companyName || company,
        evidence: evidence.map(({ id, label, facts }) => ({ id, label, facts })),
        claims: subset.map((c) => ({ claim_id: c.id, slide: c.slide, category: c.category, claim: c.text, quote: c.quote })),
      },
      null,
      1
    );
    const out = await generateJson({ system: JUDGE_SYSTEM, prompt, schema: VERDICT_SCHEMA });
    return out.verdicts ?? [];
  };
  let judged = await judge(claims);

  // 4b. Second pass: claims the company/people data couldn't settle get a Crustdata
  // web search, then are judged again with the extra evidence.
  const unsettled = claims.filter((c) => {
    const v = judged.find((j) => j.claim_id === c.id)?.verdict ?? 'unverifiable';
    return (v === 'unverifiable' || v === 'partially_verified') && !searched.has(c.id);
  });
  const budget = Math.max(0, MAX_WEB_SEARCHES - searched.size);
  if (cd && unsettled.length && budget) {
    const second = unsettled.slice(0, budget);
    onProgress({ step: 'web', message: `Searching the web through Crustdata for ${second.length} unsettled claim(s)…` });
    const before = evidence.length;
    await searchWeb(second);
    if (evidence.length > before) {
      // Re-judge every unsettled claim: new results found for one claim often settle another.
      const rejudge = claims.filter((c) => {
        const v = judged.find((j) => j.claim_id === c.id)?.verdict ?? 'unverifiable';
        return v === 'unverifiable' || v === 'partially_verified';
      });
      onProgress({ step: 'judge', message: `Gemini is re-judging ${rejudge.length} claim(s) with web evidence…` });
      const again = await judge(rejudge).catch((err) => (warnings.push(`Second-pass judging failed: ${err.message}`), []));
      judged = [...judged.filter((j) => !again.some((x) => x.claim_id === j.claim_id)), ...again];
    }
  }
  const byId = new Map([...evidence, ...lookups].map((e) => [e.id, e]));

  // 5. Enforce: every verdict has a reason and a source
  const results = {};
  for (const c of claims) {
    const v = judged.find((j) => j.claim_id === c.id);
    const cited = (v?.evidence_ids ?? []).map((id) => byId.get(id)).filter(Boolean);
    let verdict = v?.verdict ?? 'unverifiable';
    let reason = v?.reason?.trim() || '';
    if (verdict !== 'unverifiable' && !cited.length) {
      verdict = 'unverifiable';
      reason = `${reason} (Downgraded: no Crustdata evidence was cited for this verdict.)`.trim();
    }
    if (!reason) {
      reason = cd
        ? `Crustdata's ${CATEGORIES[c.category]?.label.toLowerCase() ?? 'company'} data does not cover this claim.`
        : 'No Crustdata company record matched, so this claim could not be checked.';
    }
    const fallback = [byId.get(`lookup.web.${c.id}`), c.category === 'founder_background' ? byId.get('lookup.people') : null, byId.get('lookup.company')].filter(Boolean);
    const sources = (cited.length ? cited : fallback.slice(0, 2)).map(({ id, label, endpoint, url, retrieved_at, data_updated_at, facts }) =>
      compact({ id, label, endpoint, url, retrieved_at, data_updated_at, facts })
    );
    if (!sources.length) {
      sources.push({ id: 'lookup.none', label: 'No Crustdata lookup possible (company unknown)', endpoint: 'POST /company/enrich', retrieved_at: retrievedAt });
    }
    results[c.id] = { verdict, reason, crustdata_value: v?.crustdata_value || '', sources, checked_at: retrievedAt };
  }

  return { results, company: companySnapshot(cd), query: company, warnings, model: await geminiModel() };
}

// ---------- one-shot pipeline ----------

// Extract → resolve the company in Crustdata → gather evidence → judge. No human steps.
export async function checkPitch(slides, { onProgress = () => {}, company: override = null } = {}) {
  const warnings = [];
  onProgress({ step: 'extract', message: 'Gemini is extracting every claim…' });
  let extracted;
  let extractor = 'gemini';
  try {
    extracted = await extractWithGemini(slides);
  } catch (err) {
    extractor = 'pattern';
    warnings.push(`Gemini claim extraction failed, so pattern matching was used instead: ${err.message}`);
    extracted = extractHeuristic(slides);
  }
  const { claims, founders } = extracted;
  const hints = pitchHints(claims, { ...extracted.company, ...(override ?? {}) }, founders);

  onProgress({ step: 'resolve', message: `Resolving “${hints.name || hints.domain}” in Crustdata…` });
  const resolution = await resolveCompany(hints);
  if (resolution && !resolution.id) warnings.push(`Crustdata has no company matching ${hints.domain || hints.name}.`);
  if (resolution?.candidates > 1 && resolution.method === 'name') {
    const alt = resolution.alternatives.map((a) => `${a.name} (${a.domain ?? 'no domain'})`).join(', ');
    warnings.push(
      `${resolution.candidates} companies in Crustdata match “${hints.name}”. Picked ${resolution.name} (${resolution.domain}) because: ${resolution.why.join('; ') || 'highest confidence'}.${alt ? ` Other candidates: ${alt}.` : ''} If this is wrong, set the domain and verify again.`
    );
  }
  const company = resolution?.id
    ? { id: resolution.id, name: resolution.name, domain: resolution.domain }
    : { name: hints.name ?? null, domain: hints.domain ?? null };

  const verified = claims.length
    ? await verifyClaims({ slides, claims, company, founders, profile: resolution?.profile ?? null, onProgress })
    : { results: {}, company: null, warnings: ['No checkable claims found.'], model: null };

  return {
    claims,
    founders,
    extractor,
    company,
    resolution: resolution && { ...resolution, profile: undefined },
    hints,
    results: verified.results,
    snapshot: verified.company,
    model: verified.model,
    warnings: [...warnings, ...verified.warnings],
  };
}
