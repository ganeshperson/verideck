// Crustdata API client (https://docs.crustdata.com, API version 2025-11-01).

const BASE = 'https://api.crustdata.com';
export const API_VERSION = '2025-11-01';
export const crustdataEnabled = () => Boolean(process.env.CRUSTDATA_API_KEY);

// `people` is fetched separately: for large companies it can take over a minute.
export const COMPANY_FIELDS = ['basic_info', 'headcount', 'funding', 'hiring', 'locations', 'social_profiles'];

export class CrustdataError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMEOUT_MS = 45_000;

async function post(path, body, attempt = 0, timeoutMs = TIMEOUT_MS) {
  if (!crustdataEnabled()) throw new CrustdataError('CRUSTDATA_API_KEY is not set (add it to .env).', 503);
  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`,
        'content-type': 'application/json',
        'x-api-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text(); // the timeout covers reading the body too
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    console.log(`[crustdata] ${path} → ${err.name} after ${Date.now() - started}ms`);
    if (attempt < 1 && timeoutMs >= TIMEOUT_MS) return post(path, body, attempt + 1, timeoutMs);
    throw new CrustdataError(`Crustdata ${path} ${timedOut ? `timed out after ${timeoutMs / 1000}s` : `request failed: ${err.message}`}.`, 504);
  }
  console.log(`[crustdata] ${path} → ${res.status} in ${Date.now() - started}ms`);
  if (res.status === 429 && attempt < 2) {
    const wait = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
    await sleep(Math.min(wait, 30) * 1000);
    return post(path, body, attempt + 1, timeoutMs);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 404) return null; // documented "not found" for lookups
  if (!res.ok) {
    const err = data?.error;
    const detail =
      (typeof err === 'object' ? err?.message : null) || data?.description || data?.reason || (typeof err === 'string' ? err : null) || text.slice(0, 200);
    const hint = res.status === 401 ? ' Check CRUSTDATA_API_KEY.' : res.status === 403 ? ' Your plan may not include this endpoint.' : '';
    throw new CrustdataError(`Crustdata ${path} failed (${res.status}): ${String(detail).replace(/\.$/, '')}.${hint}`, 502);
  }
  return data;
}

const best = (matches) => matches.reduce((a, b) => ((b.confidence_score ?? 0) > (a.confidence_score ?? 0) ? b : a));

// POST /company/identify (free): candidate companies for a domain or name, best first.
export async function identifyCompany({ domain, name }) {
  const body = domain ? { domains: [domain], exact_match: true } : { names: [name] };
  const data = await post('/company/identify', body);
  return (data?.[0]?.matches ?? [])
    .map((m) => ({ confidence: m.confidence_score ?? 0, id: m.company_data?.crustdata_company_id ?? m.company_data?.basic_info?.crustdata_company_id, ...m.company_data?.basic_info }))
    .filter((c) => c.id)
    .sort((a, b) => b.confidence - a.confidence);
}

// POST /company/enrich: full profile by Crustdata ID (preferred), domain, or name.
export async function enrichCompany({ id, domain, name }) {
  const body = id
    ? { crustdata_company_ids: [id], fields: COMPANY_FIELDS }
    : domain
      ? { domains: [domain], fields: COMPANY_FIELDS, exact_match: true }
      : { names: [name], fields: COMPANY_FIELDS };
  let data = await post('/company/enrich', body);
  let matches = data?.[0]?.matches ?? [];
  if (!matches.length && !id && domain && name) {
    data = await post('/company/enrich', { names: [name], fields: COMPANY_FIELDS });
    matches = data?.[0]?.matches ?? [];
  }
  if (!matches.length) return null;
  const top = best(matches);
  return { ...top.company_data, _confidence: top.confidence_score, _candidates: matches.length };
}

// POST /company/enrich with only `people` (founders, CXOs). Slow for big companies,
// so it has its own short budget; callers fall back to people search on timeout.
export async function companyPeople(id, timeoutMs = 25_000) {
  const data = await post('/company/enrich', { crustdata_company_ids: [id], fields: ['people'] }, 0, timeoutMs);
  return data?.[0]?.matches?.[0]?.company_data?.people ?? null;
}

// POST /person/search: people whose current role at this company has a founder title.
export async function foundersAtCompany(domain, limit = 10) {
  if (!domain) return [];
  const data = await post('/person/search', {
    filters: {
      op: 'and',
      conditions: [
        { field: 'experience.employment_details.current.company_website_domain', type: '=', value: domain },
        { field: 'experience.employment_details.current.title', type: '(.)', value: 'founder' },
      ],
    },
    limit,
  });
  return data?.profiles ?? [];
}

// POST /person/search: profiles (with experience + education) by Crustdata person ID.
export async function peopleById(ids) {
  if (!ids.length) return [];
  const data = await post('/person/search', {
    filters: { field: 'crustdata_person_id', type: 'in', value: ids },
    limit: Math.min(ids.length, 25),
  });
  return data?.profiles ?? [];
}

// POST /person/search: people with these names who have worked at the company
// (matched by website domain when known, otherwise by company name).
export async function peopleByNameAtCompany(names, { name, domain } = {}) {
  if (!names.length || !(name || domain)) return [];
  const employer = domain
    ? { field: 'experience.employment_details.company_website_domain', type: '=', value: domain }
    : { field: 'experience.employment_details.company_name', type: '(.)', value: name };
  const data = await post('/person/search', {
    filters: { op: 'and', conditions: [{ field: 'basic_profile.name', type: 'in', value: names }, employer] },
    limit: Math.min(names.length * 2, 25),
  });
  return data?.profiles ?? [];
}

// POST /web/search/live: web results for claims Crustdata's datasets don't cover.
export async function webSearch(query) {
  const data = await post('/web/search/live', { query, sources: ['web', 'news'], location: 'US' });
  return (data?.results ?? [])
    .map((r) => ({ ...r, url: directUrl(r.url) }))
    .filter((r) => r.url)
    .slice(0, 5);
}

// Some results come back as opaque search-engine redirects; unwrap them when the
// target is in the query string, and drop them when it isn't (not a usable source link).
function directUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && /^\/(goto|url)$/.test(u.pathname)) {
      const target = u.searchParams.get('url') || u.searchParams.get('q');
      return target && /^https?:\/\//.test(target) ? target : null;
    }
    return url;
  } catch {
    return null;
  }
}
