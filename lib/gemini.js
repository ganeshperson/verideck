// Gemini API client (generateContent with JSON schema output).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const RETRYABLE = new Set([429, 500, 503, 504]);
export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

let resolved = null; // available flash models, newest first
let lastGood = null; // model that last answered successfully

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GEMINI_MODEL if set; otherwise the stable Flash (then Flash-Lite) models this key can use, newest first.
async function candidateModels() {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (resolved) return resolved;
  try {
    const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
    if (!res.ok) return [FALLBACK_MODEL]; // don't cache: the key may be fixed later
    const { models = [] } = await res.json();
    const version = (n) => parseFloat(n.match(/gemini-(\d+(\.\d+)?)/)?.[1] ?? 0);
    const names = models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
    const newest = (re) => names.filter((n) => re.test(n)).sort((a, b) => version(b) - version(a));
    // Stable Flash models first, then Flash-Lite as a fallback when Flash is overloaded.
    const pool = [...newest(/^gemini-[\d.]+-flash$/).slice(0, 5), ...newest(/^gemini-[\d.]+-flash-lite$/).slice(0, 2)];
    resolved = pool.length ? pool : [FALLBACK_MODEL];
  } catch {
    return [FALLBACK_MODEL];
  }
  return resolved;
}

export async function geminiModel() {
  return lastGood ?? (await candidateModels())[0];
}

const TIMEOUT_MS = 40_000;
const COOLDOWN_MS = 5 * 60_000; // skip an overloaded model for this long
const overloadedUntil = new Map();
const DEADLINE_MS = 180_000; // give up on a single generateJson call after this

async function callModel(model, body) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[gemini] ${model} → ${res.status} in ${Date.now() - started}ms`);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.log(`[gemini] ${model} → ${err.name} after ${Date.now() - started}ms`);
    // Treat timeouts and network errors like an overloaded model: retry, then fall back.
    return { ok: false, status: 504, data: { error: { message: err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message } } };
  }
}

export async function generateJson({ system, prompt, schema, temperature = 0.1 }) {
  if (!geminiEnabled()) throw Object.assign(new Error('GEMINI_API_KEY is not set (add it to .env).'), { status: 503 });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
  };
  const models = await candidateModels();
  // Last model that worked first, then the rest, with recently overloaded models at the back.
  const now = Date.now();
  const cooling = (m) => (overloadedUntil.get(m) ?? 0) > now;
  const order = [...models].sort((x, y) => (x === lastGood ? -1 : y === lastGood ? 1 : 0) || cooling(x) - cooling(y));

  let failure;
  const deadline = now + DEADLINE_MS;
  for (const model of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error(`${failure ?? 'Gemini request failed'}. Gemini is overloaded right now; try again in a minute.`), { status: 503 });
      }
      const { ok, status, data } = await callModel(model, body);
      if (ok) {
        lastGood = model;
        overloadedUntil.delete(model);
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        try {
          return JSON.parse(text);
        } catch {
          failure = `Gemini ${model} returned invalid JSON (finish reason: ${data.candidates?.[0]?.finishReason ?? 'none'})`;
          break; // try the next model
        }
      }
      failure = `Gemini ${model} failed (${status}): ${data.error?.message ?? 'unknown error'}`;
      if (status === 404) break; // model not available to this key: try the next one
      if (!RETRYABLE.has(status)) throw Object.assign(new Error(failure), { status: 502 }); // bad key or request
      overloadedUntil.set(model, Date.now() + COOLDOWN_MS);
      if (lastGood === model) lastGood = null;
      if (status === 504) break; // timed out: don't wait on it again, switch models now
      if (attempt === 0) await sleep(1500);
    }
  }
  throw Object.assign(new Error(failure ?? 'Gemini request failed'), { status: 502 });
}
