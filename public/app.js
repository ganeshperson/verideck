import { deckScore } from '/shared/score.js';

const $ = (sel) => document.querySelector(sel);
const STORE = 'verideck:';
const RECENT_KEY = STORE + 'recent';

const TYPE_LABELS = {
  headcount: 'Headcount',
  funding: 'Funding',
  founded: 'Founded year',
  founder_background: 'Founder background',
  hiring: 'Hiring',
  location: 'Location',
  growth: 'Growth',
  other: 'Other claim',
  manual: 'Flagged by you',
};
const VERDICTS = {
  verified: { label: 'Verified', cls: 'ok', icon: '✅' },
  partially_verified: { label: 'Partly verified', cls: 'medium', icon: '🟡' },
  contradicted: { label: 'Contradicted', cls: 'bad', icon: '❌' },
  unverifiable: { label: 'Unverifiable', cls: '', icon: '❔' },
};

let config = { crustdata: false, gemini: false, model: null };
let deck = null; // { id, name, slides, claims, manual, states, company, founders, snapshot, warnings, extractor }
const filters = { level: 'all', status: 'all', showText: false, showDismissed: false };

// ---------- utilities ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (error ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : 2800);
}

function loading(on, text = 'Analyzing…') {
  $('#loading').hidden = !on;
  $('#loadingText').textContent = text;
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s) => (s || 'deck').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 60);
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

// ---------- persistence ----------
function save() {
  if (!deck) return;
  const record = { ...deck, savedAt: Date.now() };
  try {
    localStorage.setItem(STORE + 'deck:' + deck.id, JSON.stringify(record));
    const recent = loadRecent().filter((r) => r.id !== deck.id);
    recent.unshift({ id: deck.id, name: deck.name, savedAt: record.savedAt, score: summary().score });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 8)));
  } catch {
    // Storage full or disabled: keep working in memory.
  }
}

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function loadDeck(id) {
  try {
    return JSON.parse(localStorage.getItem(STORE + 'deck:' + id));
  } catch {
    return null;
  }
}

function removeRecent(id) {
  localStorage.removeItem(STORE + 'deck:' + id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(loadRecent().filter((r) => r.id !== id)));
  renderRecent();
}

// ---------- deck state ----------
const allClaims = () => [...deck.claims, ...deck.manual].sort((a, b) => a.slide - b.slide);
const stateOf = (id) => (deck.states[id] ??= {});
const summary = () => deckScore(allClaims(), deck.states);

function status(claim) {
  const st = deck.states[claim.id] ?? {};
  if (st.dismissed) return 'dismissed';
  return st.verification?.verdict ?? 'unchecked';
}

function resetFilters() {
  Object.assign(filters, { level: 'all', status: 'all', showText: false, showDismissed: false });
  document.querySelectorAll('#levelFilter .chip, #statusFilter .chip').forEach((c) => c.classList.toggle('on', c.dataset.v === 'all'));
  $('#showText').checked = false;
  $('#showDismissed').checked = false;
}

// `result` is a /api/check (or /api/analyze) response.
function openDeck(result) {
  const { deck: d, claims } = result;
  const id = hash(d.name + '\n' + d.slides.map((s) => s.lines.join('\n')).join('\n---\n'));
  const saved = loadDeck(id);
  const states = {};
  // Keep what the user did by hand (their sources, dismissals); verdicts come fresh.
  for (const [cid, st] of Object.entries(saved?.states ?? {})) {
    states[cid] = { ...(st.sources ? { sources: st.sources } : {}), ...(st.dismissed ? { dismissed: true } : {}) };
  }
  for (const [cid, v] of Object.entries(result.results ?? {})) (states[cid] ??= {}).verification = v;
  deck = {
    id,
    name: d.name === 'Pasted pitch' && result.company?.name ? `${result.company.name} pitch` : d.name,
    slides: d.slides,
    claims,
    extractor: result.extractor,
    manual: saved?.manual ?? [],
    states,
    company: result.company ?? saved?.company ?? { name: '', domain: '' },
    resolution: result.resolution ?? null,
    founders: result.founders ?? [],
    snapshot: result.snapshot ?? null,
    warnings: result.warnings ?? [],
  };
  resetFilters();
  save();
  showResults();
}

// ---------- intake ----------

const STEPS = [
  ['extract', 'Extract claims (Gemini)'],
  ['resolve', 'Resolve company (Crustdata Identify)'],
  ['company', 'Fetch company data (Crustdata Enrich)'],
  ['people', 'Founders + web evidence (Crustdata)'],
  ['judge', 'Judge each claim (Gemini)'],
];

function showProgress(step, message) {
  const at = STEPS.findIndex(([k]) => k === (step === 'web' ? 'people' : step));
  const list = STEPS.map(([k, label], i) => {
    const mark = at === -1 ? '○' : i < at ? '✓' : i === at ? '●' : '○';
    return `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${mark} ${esc(label)}</li>`;
  }).join('');
  $('#loading').hidden = false;
  $('#loadingText').innerHTML = `<ol class="steps">${list}</ol><div class="step-msg">${esc(message ?? '')}</div>`;
}

// One click: POST the pitch to /api/check and follow its progress stream.
async function checkPitch(body, headers) {
  showProgress('extract', 'Sending your pitch…');
  try {
    const res = await fetch('/api/check', { method: 'POST', headers: { accept: 'application/x-ndjson', ...headers }, body });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'progress') showProgress(msg.step, msg.message);
        else if (msg.type === 'error') throw new Error(msg.error);
        else if (msg.type === 'result') result = msg;
      }
    }
    if (buf.trim()) {
      const msg = JSON.parse(buf);
      if (msg.type === 'error') throw new Error(msg.error);
      if (msg.type === 'result') result = msg;
    }
    if (!result) throw new Error('The check ended without a result. Try again.');
    openDeck(result);
    const c = summary().counts;
    toast(Object.keys(result.results ?? {}).length ? `Done: ${c.verified} verified, ${c.partially_verified} partly, ${c.contradicted} contradicted, ${c.unverifiable} unverifiable.` : 'Claims extracted (not verified).');
  } catch (err) {
    toast(err.message, true);
  } finally {
    loading(false);
  }
}

// ---------- intake ----------
function analyzeFile(file) {
  if (!file) return;
  if (!/\.(pptx|md|markdown|txt)$/i.test(file.name)) {
    toast('VeriDeck reads .pptx, .md, and .txt files. Export Keynote or Google Slides decks to .pptx first.', true);
    return;
  }
  return checkPitch(file, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) });
}

function analyzeText(text, name = 'Pasted pitch') {
  if (!text.trim()) return toast('Paste a pitch first.', true);
  return checkPitch(JSON.stringify({ text, name }), { 'content-type': 'application/json' });
}

function renderKeys() {
  const k = (on, name) => `<span class="${on ? 'on' : 'off'}">${on ? '●' : '○'} ${name} ${on ? 'connected' : 'not set'}</span>`;
  $('#keyStatus').innerHTML = `${k(config.crustdata, 'Crustdata')} &nbsp; ${k(config.gemini, 'Gemini')}${
    config.crustdata && config.gemini ? '' : ' · add the missing key(s) to <code>.env</code> and restart'
  }`;
}

function renderRecent() {
  const recent = loadRecent();
  $('#recent').hidden = !recent.length;
  $('#recentList').innerHTML = recent
    .map(
      (r) => `<li>
        <button class="open" data-open="${esc(r.id)}">${esc(r.name)}</button>
        <span>Score ${r.score} · ${new Date(r.savedAt).toLocaleDateString()}</span>
        <button class="linkbtn" data-forget="${esc(r.id)}">Remove</button>
      </li>`
    )
    .join('');
}

function showIntake() {
  deck = null;
  $('#results').hidden = true;
  $('#deckActions').hidden = true;
  $('#intake').hidden = false;
  renderRecent();
}

function showResults() {
  $('#intake').hidden = true;
  $('#results').hidden = false;
  $('#deckActions').hidden = false;
  render();
  window.scrollTo(0, 0);
}

// ---------- results rendering ----------
function highlight(text) {
  const re =
    /([$€£¥]?\d[\d,.]*\s?(%|\+|x\b|k\b|m\b|bn\b|million|billion)?|\b(founded|raised|series [a-f]|seed|ex-\w+|former(ly)?|previously|hiring|employees|team of)\b)/gi;
  return esc(text).replace(re, '<mark>$1</mark>');
}

function renderSidebar() {
  const s = summary();
  const color = s.score >= 70 ? 'var(--ok)' : s.score >= 40 ? 'var(--medium)' : 'var(--high)';
  $('#scoreNum').textContent = s.score;
  const bar = $('#ringBar');
  bar.style.strokeDashoffset = String(326.7 * (1 - s.score / 100));
  bar.style.stroke = color;
  $('#deckName').textContent = deck.name;
  $('#grade').textContent = !s.active
    ? 'No checkable claims found'
    : s.counts.unchecked === s.active
      ? `${s.active} claims found · not verified yet`
      : `Grade ${s.grade} · ${s.counts.verified} of ${s.active} verified by Crustdata`;

  $('#stats').innerHTML = `
    <div><dt>Claims</dt><dd>${s.active}</dd></div>
    <div class="ok"><dt>Verified</dt><dd>${s.counts.verified}</dd></div>
    <div class="medium"><dt>Partly</dt><dd>${s.counts.partially_verified}</dd></div>
    <div class="bad"><dt>Contradicted</dt><dd>${s.counts.contradicted}</dd></div>
    <div><dt>Unverifiable</dt><dd>${s.counts.unverifiable}</dd></div>
    <div><dt>Not checked</dt><dd>${s.counts.unchecked}</dd></div>`;

  renderCompanyBox();

  const warnings = deck.warnings ?? [];
  $('#warnBox').hidden = !warnings.length;
  $('#warnBox').innerHTML = warnings.map((w) => `<p>⚠️ ${esc(w)}</p>`).join('');
}

function renderCompanyBox() {
  const ready = config.crustdata && config.gemini;
  const c = deck.company ?? {};
  const snap = deck.snapshot;
  const pending = allClaims().filter((x) => !deck.states[x.id]?.dismissed).length;
  const row = (k, v) => (v || v === 0 ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const link = (u, t) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>` : '');
  $('#companyBox').innerHTML = `
    <h3>Company</h3>
    <label>Name <input id="coName" value="${esc(c.name)}" placeholder="e.g. Retool" /></label>
    <label>Domain <input id="coDomain" value="${esc(c.domain)}" placeholder="e.g. retool.com" /></label>
    ${ready
      ? `<button class="btn ${snap ? 'ghost' : ''}" id="runVerify" ${pending ? '' : 'disabled'}>${snap ? 'Re-verify with these details' : `Verify ${pending} claims with Crustdata`}</button>`
      : `<p>Verification needs ${[!config.crustdata && '<code>CRUSTDATA_API_KEY</code>', !config.gemini && '<code>GEMINI_API_KEY</code>'].filter(Boolean).join(' and ')} in <code>.env</code>.</p>`}
    ${snap
      ? `<dl class="snapshot">
          ${row('Crustdata', esc(snap.name))}
          ${row('Domain', link(snap.website || (snap.domain && `https://${snap.domain}`), snap.domain || snap.website))}
          ${row('Founded', esc(snap.year_founded))}
          ${row('Headcount', snap.headcount != null ? `${esc(Number(snap.headcount).toLocaleString())}${snap.headcount_yoy_percent != null ? ` (${snap.headcount_yoy_percent > 0 ? '+' : ''}${esc(Number(snap.headcount_yoy_percent).toFixed(1))}% YoY)` : ''}` : esc(snap.employee_count_range))}
          ${row('Funding', esc(snap.total_funding))}
          ${row('Last round', esc(snap.last_round))}
          ${row('Open roles', esc(snap.open_roles))}
          ${row('HQ', esc(snap.headquarters))}
          ${row('Founders', esc((snap.founders ?? []).join(', ')))}
          ${row('Links', [link(snap.profile_url, 'Profile'), link(snap.crunchbase_url, 'Crunchbase')].filter(Boolean).join(' · '))}
          ${row('Data as of', esc(snap.updated_at))}
        </dl>`
      : ''}
    ${deck.resolution?.id ? `<p class="resolved">Resolved automatically via Crustdata Identify${deck.resolution.candidates > 1 ? ` from ${deck.resolution.candidates} same-named companies` : ''}${deck.resolution.why?.length ? `: ${esc(deck.resolution.why.join('; '))}` : ''}.</p>` : ''}
    <p style="margin-top:10px">Claims extracted by ${deck.extractor === 'gemini' ? 'Gemini + pattern matching' : 'pattern matching'}.</p>`;
}

function renderVerification(v) {
  if (!v) return '';
  const meta = VERDICTS[v.verdict] ?? VERDICTS.unverifiable;
  const sources = (v.sources ?? [])
    .map((s) => {
      const url = safeUrl(s.url);
      const facts = s.facts ? `<details><summary>Crustdata data</summary><pre>${esc(JSON.stringify(s.facts, null, 2))}</pre></details>` : '';
      return `<li>📎 ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : `<strong>${esc(s.label)}</strong>`}
        · Crustdata <code>${esc(s.endpoint)}</code> · retrieved ${esc(shortDate(s.retrieved_at))}${s.data_updated_at ? ` · data updated ${esc(shortDate(s.data_updated_at))}` : ''}
        ${facts}</li>`;
    })
    .join('');
  return `<div class="verdict ${v.verdict}">
    <div class="verdict-head"><span class="badge ${meta.cls}">${meta.icon} ${meta.label}</span></div>
    <div><strong>Reason:</strong> ${esc(v.reason)}</div>
    ${v.crustdata_value ? `<div class="value">Crustdata: ${esc(v.crustdata_value)}</div>` : ''}
    <ul class="vsources">${sources}</ul>
  </div>`;
}

function renderClaim(c) {
  const st = deck.states[c.id] ?? {};
  const stat = status(c);
  const cls = ['claim', VERDICTS[stat] ? stat : c.level, st.dismissed ? 'dismissed' : ''].join(' ');

  const badges = [
    ...c.types.map((t) => `<span class="badge">${esc(TYPE_LABELS[t] || t)}</span>`),
    stat === 'unchecked' ? `<span class="badge ${c.level}">Not checked yet</span>` : '',
    st.sources?.length ? '<span class="badge ok">Your source</span>' : '',
  ].join('');

  const sources = (st.sources ?? [])
    .map(
      (src, i) => `<li>✓ ${safeUrl(src.url) ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.url)}</a>` : esc(src.url)}
        ${src.note ? `<span>· ${esc(src.note)}</span>` : ''}
        <button class="linkbtn" data-action="unsource" data-id="${c.id}" data-i="${i}">remove</button></li>`
    )
    .join('');

  return `<article class="${cls}" data-claim="${c.id}">
    <div class="claim-top">
      <div style="flex:1;min-width:0">
        <p class="claim-text">${highlight(c.text)}</p>
        ${c.quote && c.quote !== c.text ? `<p class="claim-quote">From the slide: “${esc(c.quote)}”</p>` : ''}
        <div class="badges">${badges}</div>
      </div>
      <div class="risk ${c.level}" title="How much a wrong claim here would hurt credibility"><b>${c.risk}</b><small>stakes</small></div>
    </div>
    ${st.verification ? renderVerification(st.verification) : `<div class="claim-detail"><p>${esc(c.suggestion)}</p></div>`}
    ${sources ? `<ul class="sources">${sources}</ul>` : ''}
    <form class="source-form" data-id="${c.id}" hidden>
      <input name="url" placeholder="Your own source: URL or citation" required />
      <input name="note" placeholder="Note (optional)" />
      <button class="btn small">Save source</button>
    </form>
    <div class="claim-actions">
      ${st.dismissed ? '' : `<button class="btn small ghost" data-action="add-source" data-id="${c.id}">+ Add your own source</button>`}
      ${c.manual
        ? `<button class="linkbtn" data-action="remove-manual" data-id="${c.id}">Remove</button>`
        : `<button class="linkbtn" data-action="dismiss" data-id="${c.id}">${st.dismissed ? 'Restore' : 'Not a claim'}</button>`}
    </div>
  </article>`;
}

function claimVisible(c) {
  const stat = status(c);
  if (stat === 'dismissed' && !filters.showDismissed) return false;
  if (filters.level !== 'all' && c.level !== filters.level) return false;
  if (filters.status !== 'all' && stat !== filters.status) return false;
  return true;
}

function renderSlides() {
  const claims = allClaims();
  const filtering = filters.level !== 'all' || filters.status !== 'all';
  let shown = 0;

  const html = deck.slides
    .map((slide) => {
      const slideClaims = claims.filter((c) => c.slide === slide.index);
      const visible = slideClaims.filter(claimVisible);
      shown += visible.length;
      if (filtering && !visible.length) return '';
      const claimIds = new Set(slideClaims.map((c) => c.sentenceId ?? c.id));
      const extra = filters.showText
        ? slide.sentences
            .filter((s) => !claimIds.has(s.id))
            .map(
              (s) => `<div class="sentence"><span>${esc(s.text)}</span>
                <button class="btn small ghost" data-action="flag" data-slide="${slide.index}" data-sid="${s.id}">Flag as claim</button></div>`
            )
            .join('')
        : '';
      const notes = filters.showText && slide.notes.length ? `<div class="notes">Speaker notes: ${esc(slide.notes.join(' '))}</div>` : '';
      const bad = slideClaims.filter((c) => status(c) === 'contradicted').length;
      const meta = slideClaims.length
        ? `${slideClaims.length} claim${slideClaims.length > 1 ? 's' : ''}${bad ? ` · ${bad} contradicted` : ''}`
        : 'No claims';
      const body = visible.map(renderClaim).join('') + extra + notes;
      return `<section class="slide">
        <header class="slide-head">
          <span class="slide-num">${slide.index}</span>
          <span class="slide-title">${esc(slide.title)}</span>
          <span class="slide-meta">${meta}</span>
        </header>
        <div class="slide-body">${body || '<div class="slide-empty">Nothing to check here. Turn on “Show all slide text” to flag something by hand.</div>'}</div>
      </section>`;
    })
    .join('');

  $('#slides').innerHTML =
    filtering && !shown
      ? `<div class="empty-state">No claims match these filters (${claims.length} claims in this deck).<br><br><button class="btn" data-action="show-all">Show all claims</button></div>`
      : html;
}

function render() {
  renderSidebar();
  renderSlides();
}

function update() {
  save();
  render();
}

// ---------- actions ----------
async function runVerify() {
  deck.company = { name: $('#coName').value.trim(), domain: $('#coDomain').value.trim().toLowerCase() };
  if (!deck.company.name && !deck.company.domain) return toast('Enter the company name or domain first.', true);
  const targets = allClaims()
    .filter((c) => !deck.states[c.id]?.dismissed)
    .map(({ id, slide, slideTitle, text, quote, types, category }) => ({ id, slide, slideTitle, text, quote, types, category: category ?? types[0] }));
  loading(true, `Checking ${targets.length} claims against Crustdata…`);
  try {
    const out = await api('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claims: targets,
        company: deck.company,
        founders: deck.founders,
        slides: deck.slides.map(({ index, title, lines, notes }) => ({ index, title, lines, notes })),
      }),
    });
    for (const [id, v] of Object.entries(out.results)) stateOf(id).verification = v;
    deck.snapshot = out.company;
    if (out.resolvedCompany) deck.company = out.resolvedCompany;
    deck.resolution = out.resolution ?? deck.resolution;
    deck.warnings = out.warnings ?? [];
    const s = summary();
    toast(`Checked ${Object.keys(out.results).length} claims: ${s.counts.verified} verified, ${s.counts.contradicted} contradicted.`);
    update();
  } catch (err) {
    toast(err.message, true);
  } finally {
    loading(false);
  }
}

function flagSentence(slideIndex, sid) {
  const slide = deck.slides.find((s) => s.index === slideIndex);
  const sentence = slide?.sentences.find((s) => s.id === sid);
  if (!sentence) return;
  deck.manual.push({
    id: sid,
    slide: slideIndex,
    slideTitle: slide.title,
    text: sentence.text,
    types: ['other'],
    category: 'other',
    reasons: [],
    risk: 40,
    level: 'medium',
    citation: null,
    manual: true,
    suggestion: 'You flagged this one. Verify again to check it against Crustdata.',
  });
  update();
}

$('#slides').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.action) {
    case 'show-all':
      resetFilters();
      renderSlides();
      break;
    case 'add-source': {
      const form = btn.closest('.claim').querySelector('.source-form');
      form.hidden = !form.hidden;
      if (!form.hidden) form.url.focus();
      break;
    }
    case 'unsource':
      stateOf(id).sources.splice(Number(btn.dataset.i), 1);
      update();
      break;
    case 'dismiss':
      stateOf(id).dismissed = !stateOf(id).dismissed;
      update();
      break;
    case 'remove-manual':
      deck.manual = deck.manual.filter((c) => c.id !== id);
      delete deck.states[id];
      update();
      break;
    case 'flag':
      flagSentence(Number(btn.dataset.slide), btn.dataset.sid);
      break;
  }
});

$('#slides').addEventListener('submit', (e) => {
  const form = e.target.closest('.source-form');
  if (!form) return;
  e.preventDefault();
  const url = form.url.value.trim();
  if (!url) return;
  const st = stateOf(form.dataset.id);
  (st.sources ??= []).push({ url, note: form.note.value.trim(), addedAt: Date.now() });
  update();
  toast('Source saved.');
});

$('#companyBox').addEventListener('click', (e) => {
  if (e.target.id === 'runVerify') runVerify();
});
$('#companyBox').addEventListener('change', (e) => {
  if (e.target.id === 'coName' || e.target.id === 'coDomain') {
    deck.company = { name: $('#coName').value.trim(), domain: $('#coDomain').value.trim().toLowerCase() };
    save();
  }
});

for (const [group, key] of [['#levelFilter', 'level'], ['#statusFilter', 'status']]) {
  $(group).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filters[key] = chip.dataset.v;
    $(group).querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    renderSlides();
  });
}
$('#showText').addEventListener('change', (e) => ((filters.showText = e.target.checked), renderSlides()));
$('#showDismissed').addEventListener('change', (e) => ((filters.showDismissed = e.target.checked), renderSlides()));

// ---------- export ----------
function markdownReport() {
  const s = summary();
  const snap = deck.snapshot;
  const lines = [
    `# VeriDeck report: ${deck.name}`,
    '',
    `Generated ${new Date().toLocaleString()} · company: ${deck.company?.name || '?'} (${deck.company?.domain || 'no domain'})`,
    '',
    `**Credibility score: ${s.score}/100 (grade ${s.grade}).** ${s.counts.verified} verified, ${s.counts.partially_verified} partly verified, ${s.counts.contradicted} contradicted, ${s.counts.unverifiable} unverifiable, ${s.counts.unchecked} not checked.`,
    '',
  ];
  if (snap) {
    lines.push('## Crustdata company snapshot', '');
    for (const [k, v] of Object.entries(snap)) lines.push(`- ${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : v}`);
    lines.push('');
  }
  for (const slide of deck.slides) {
    const claims = allClaims().filter((c) => c.slide === slide.index && !deck.states[c.id]?.dismissed);
    if (!claims.length) continue;
    lines.push(`## Slide ${slide.index}: ${slide.title}`, '');
    for (const c of claims) {
      const st = deck.states[c.id] ?? {};
      const v = st.verification;
      const meta = v ? VERDICTS[v.verdict] : null;
      lines.push(`- ${meta ? meta.icon : '⏳'} **${c.text}**`);
      lines.push(`  - Category: ${c.types.map((t) => TYPE_LABELS[t] || t).join(', ')}`);
      if (v) {
        lines.push(`  - Verdict: ${meta.label}`);
        lines.push(`  - Reason: ${v.reason}`);
        if (v.crustdata_value) lines.push(`  - Crustdata value: ${v.crustdata_value}`);
        for (const src of v.sources ?? []) {
          lines.push(`  - Source: ${src.label} (Crustdata ${src.endpoint}, retrieved ${shortDate(src.retrieved_at)})${src.url ? ` ${src.url}` : ''}`);
        }
      } else {
        lines.push('  - Not verified yet');
      }
      for (const src of st.sources ?? []) lines.push(`  - Your source: ${src.url}${src.note ? ` (${src.note})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

$('#exportMd').addEventListener('click', () =>
  download(`${safeName(deck.name)}-verideck.md`, markdownReport(), 'text/markdown')
);
$('#exportJson').addEventListener('click', () =>
  download(
    `${safeName(deck.name)}-verideck.json`,
    JSON.stringify(
      {
        deck: deck.name,
        company: deck.company,
        crustdata_snapshot: deck.snapshot,
        summary: summary(),
        claims: allClaims().map((c) => ({ ...c, ...deck.states[c.id] })),
      },
      null,
      2
    ),
    'application/json'
  )
);

// ---------- intake wiring ----------
const dz = $('#dropzone');
$('#fileInput').addEventListener('change', (e) => {
  analyzeFile(e.target.files[0]);
  e.target.value = '';
});
dz.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && $('#fileInput').click());
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => (e.preventDefault(), dz.classList.add('over'))));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  analyzeFile(e.dataTransfer.files[0]);
});
// Allow dropping anywhere on the intake screen.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!$('#intake').hidden && !dz.contains(e.target)) analyzeFile(e.dataTransfer.files[0]);
});

$('#analyzePaste').addEventListener('click', () => analyzeText($('#pasteInput').value));
$('#pasteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analyzeText($('#pasteInput').value);
});
$('#loadSample').addEventListener('click', async () => {
  const text = await fetch('/samples/zepto.md').then((r) => r.text());
  $('#pasteInput').value = text;
  analyzeText(text, 'Zepto sample pitch (test claims)');
});
$('#recentList').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  const forget = e.target.closest('[data-forget]');
  if (forget) return removeRecent(forget.dataset.forget);
  if (!open) return;
  const saved = loadDeck(open.dataset.open);
  if (!saved) return toast('That deck is no longer saved.', true);
  deck = saved;
  showResults();
});
$('#newDeck').addEventListener('click', showIntake);
$('#home').addEventListener('click', (e) => (e.preventDefault(), showIntake()));

// ---------- boot ----------
api('/api/config')
  .then((c) => (config = c))
  .catch(() => {})
  .finally(() => {
    renderKeys();
    renderRecent();
    if (deck) renderSidebar();
  });
