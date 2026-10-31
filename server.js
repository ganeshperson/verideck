import './lib/env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePptx, parseText } from './lib/pptx.js';
import { splitSentences, hashId } from './lib/claims.js';
import { deckScore } from './lib/score.js';
import { crustdataEnabled, API_VERSION } from './lib/crustdata.js';
import { geminiEnabled, geminiModel } from './lib/gemini.js';
import { extractWithGemini, extractHeuristic, verifyClaims, checkPitch, resolveCompany, pitchHints } from './lib/verify.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 50 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// URL prefix -> directory on disk. Only these are served.
const STATIC = [
  ['/shared/', join(ROOT, 'lib')],
  ['/samples/', join(ROOT, 'samples')],
  ['/', join(ROOT, 'public')],
];

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('File too large (50 MB max)'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Every sentence, so the UI can let users flag claims extraction missed.
const addSentences = (slides) =>
  slides.map((s) => ({
    ...s,
    sentences: s.lines.flatMap(splitSentences).map((text) => ({ id: hashId(`${s.index}|${text}`), text })),
  }));

// Slides from a pasted-text JSON body ({ text, name }) or a raw uploaded file (x-filename header).
async function readDeck(req) {
  const body = await readBody(req);
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    const { text, name, company } = JSON.parse(body.toString('utf8') || '{}');
    if (!text?.trim()) throw Object.assign(new Error('Paste some pitch text first.'), { status: 400 });
    return { slides: parseText(text), name: name || 'Pasted pitch', company: company ?? null };
  }
  const name = decodeURIComponent(req.headers['x-filename'] || 'deck.pptx');
  if (/\.(txt|md|markdown)$/i.test(name)) return { slides: parseText(body.toString('utf8')), name, company: null };
  if (/\.pptx$/i.test(name)) return { slides: parsePptx(body), name, company: null };
  throw Object.assign(new Error('Upload a .pptx, .md, or .txt file. (Export .key / Google Slides to .pptx first.)'), { status: 415 });
}

export async function analyze(slides, name) {
  let extracted;
  let extractor = 'heuristic';
  const warnings = [];
  if (geminiEnabled()) {
    try {
      extracted = await extractWithGemini(slides);
      extractor = 'gemini';
    } catch (err) {
      warnings.push(`Gemini claim extraction failed, so pattern matching was used instead: ${err.message}`);
    }
  }
  extracted ??= extractHeuristic(slides);
  const withSentences = addSentences(slides);
  return {
    deck: { name, slides: withSentences },
    claims: extracted.claims,
    company: extracted.company,
    founders: extracted.founders,
    extractor,
    warnings,
    summary: deckScore(extracted.claims),
  };
}

async function handleApi(req, res, path) {
  if (path === '/api/config' && req.method === 'GET') {
    return send(res, 200, {
      crustdata: crustdataEnabled(),
      gemini: geminiEnabled(),
      model: geminiEnabled() ? await geminiModel() : null,
      crustdataVersion: API_VERSION,
    });
  }

  if (path === '/api/analyze' && req.method === 'POST') {
    const { slides, name } = await readDeck(req);
    if (!slides.length) return send(res, 422, { error: 'No slide text found.' });
    return send(res, 200, await analyze(slides, name));
  }

  // One call does everything: extract → resolve company → verify against Crustdata.
  // Send `accept: application/x-ndjson` to get progress events as they happen.
  if (path === '/api/check' && req.method === 'POST') {
    const { slides, name, company } = await readDeck(req);
    if (!slides.length) return send(res, 422, { error: 'No slide text found.' });
    const stream = (req.headers.accept || '').includes('application/x-ndjson');
    const emit = (obj) => stream && res.write(JSON.stringify(obj) + '\n');
    if (stream) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });

    const finish = (payload) => {
      if (stream) {
        emit({ type: 'result', ...payload });
        res.end();
      } else send(res, 200, payload);
    };
    const missing = [!crustdataEnabled() && 'CRUSTDATA_API_KEY', !geminiEnabled() && 'GEMINI_API_KEY'].filter(Boolean);
    if (missing.length) {
      // Still useful without keys: return the claims, unverified, and say why.
      const out = await analyze(slides, name);
      return finish({ ...out, results: {}, warnings: [...out.warnings, `Not verified: add ${missing.join(' and ')} to .env and restart.`] });
    }
    try {
      const out = await checkPitch(slides, { company, onProgress: (p) => emit({ type: 'progress', ...p }) });
      const states = Object.fromEntries(Object.entries(out.results).map(([id, v]) => [id, { verification: v }]));
      finish({ deck: { name, slides: addSentences(slides) }, ...out, summary: deckScore(out.claims, states) });
    } catch (err) {
      console.error(err);
      if (!stream) throw err;
      emit({ type: 'error', error: err.message });
      res.end();
    }
    return;
  }

  if (path === '/api/verify' && req.method === 'POST') {
    const missing = [!crustdataEnabled() && 'CRUSTDATA_API_KEY', !geminiEnabled() && 'GEMINI_API_KEY'].filter(Boolean);
    if (missing.length) return send(res, 503, { error: `Verification needs ${missing.join(' and ')} in .env. Add it and restart.` });
    const { slides, claims, company, founders } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(claims) || !claims.length) return send(res, 400, { error: 'No claims to verify.' });
    if (!company?.name && !company?.domain) return send(res, 400, { error: 'Set the company name or domain first.' });
    // Re-verify after a manual edit: resolve the (possibly corrected) company first.
    const resolution = await resolveCompany(pitchHints(claims, company, founders ?? []));
    const target = resolution?.id ? { id: resolution.id, name: resolution.name, domain: resolution.domain } : company;
    const out = await verifyClaims({ slides, claims: claims.slice(0, 150), company: target, founders: founders ?? [], profile: resolution?.profile ?? null });
    return send(res, 200, { ...out, resolution: resolution && { ...resolution, profile: undefined }, resolvedCompany: target });
  }

  send(res, 404, { error: 'Not found' });
}

async function handleStatic(res, path) {
  for (const [prefix, dir] of STATIC) {
    if (!path.startsWith(prefix)) continue;
    let rel = path.slice(prefix.length) || 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      return send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
    } catch {
      if (prefix !== '/') return send(res, 404, 'Not found', 'text/plain');
    }
  }
  send(res, 404, 'Not found', 'text/plain');
}

export const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else await handleStatic(res, path);
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.message || 'Something went wrong' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`VeriDeck running at http://localhost:${PORT}`);
    console.log(`Crustdata: ${crustdataEnabled() ? 'on' : 'off (set CRUSTDATA_API_KEY in .env)'}`);
    console.log(`Gemini:    ${geminiEnabled() ? 'on' : 'off (set GEMINI_API_KEY in .env)'}`);
  });
}
