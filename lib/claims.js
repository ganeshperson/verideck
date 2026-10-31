// Heuristic claim extraction: finds checkable statements in slide text and
// rates how risky each one is to present without a source.

// Categories VeriDeck checks against Crustdata. Weight = how much a wrong claim
// in this category would hurt credibility with an investor.
export const CATEGORIES = {
  headcount: { label: 'Headcount', weight: 45 },
  funding: { label: 'Funding', weight: 55 },
  founded: { label: 'Founded year', weight: 35 },
  founder_background: { label: 'Founder background', weight: 50 },
  hiring: { label: 'Hiring', weight: 30 },
  location: { label: 'Location', weight: 20 },
  growth: { label: 'Growth', weight: 45 },
  other: { label: 'Other company claim', weight: 30 },
};

const RULES = [
  {
    type: 'headcount',
    test: (s) =>
      /\b(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a dozen|dozens of|hundreds of)\+?\s*(-|\s)?(full[- ]time\s+)?(employees|people|team members|engineers|staff|ftes?|person team|member team|teammates|developers on staff)\b/i.test(s) ||
      /\bteam of\s+(over\s+|about\s+|~|more than\s+)?(\d[\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a dozen|dozens of|hundreds of)/i.test(s) ||
      /\b\d+-(person|people|member)\b/i.test(s) ||
      /\b(headcount|employees)\b/i.test(s),
  },
  {
    type: 'funding',
    test: (s) =>
      /\b(raised|raising|funding|funded|pre-seed|seed (round|funding|stage)|series [a-f]|(funding|investment|seed|latest|recent|last) round|backed by|led by|valuation|valued at|angel investors?)\b/i.test(s) ||
      /\binvestors? (include|are|like|such as)\b/i.test(s) ||
      /\b(y ?combinator|yc [wsf]\d{2}|techstars|500 startups|accelerator|grant)\b/i.test(s),
  },
  {
    type: 'founded',
    test: (s) =>
      /\b(founded|started|launched|established|incorporated|began)\b[^.]{0,40}\b(19|20)\d{2}\b/i.test(s) ||
      /\bsince (19|20)\d{2}\b/i.test(s) ||
      /\b(in|since) (19|20)\d{2},? (we|the company)\b/i.test(s),
  },
  {
    type: 'founder_background',
    test: (s) =>
      /\b(ex-|former(ly)?|previously|prior to|alumni|alum|veteran of|spent \d+ years at|came from|built .{0,30} at|led .{0,30} at|worked at)\b/i.test(s) ||
      /\b(co-?founders?|founders?|ceo|cto|coo)\b[^.]{0,60}\b(at|from)\s+[A-Z]/.test(s) ||
      /\b([Cc]o-?)?[Ff]ounded\b[^.]{0,40}\bby\s+[A-Z]/.test(s) || /\bco-?founders? (is|are|include)\b/i.test(s) ||
      /\b(ph\.?d|mba|graduated|dropout|degree)\b/i.test(s),
  },
  {
    type: 'hiring',
    test: (s) => /\b(hiring|open roles|open positions|job openings|openings|recruiting|plan to hire|growing the team|we'?re growing)\b/i.test(s),
  },
  {
    type: 'location',
    test: (s) => /\b(headquartered|hq|based in|offices? in)\b/i.test(s),
  },
  {
    type: 'growth',
    test: (s) => /\b(grew|growth|grow|doubled|tripled|yoy|year[- ]over[- ]year|mom|month[- ]over[- ]month)\b/i.test(s) && /\d|doubled|tripled/i.test(s),
  },
  {
    type: 'other',
    test: (s) =>
      /\b(customers|clients|users|revenue|arr|mrr|profitable|partners?|used by|trusted by)\b/i.test(s) && /\d|\b(including|like|such as)\b/i.test(s),
  },
];

const CITATION_PATTERNS = [
  /https?:\/\/\S+/i,
  /\b(source|sources|via|cited|citation|ref|reference)s?\s*[:\-–]/i,
  /\baccording to\s+(the\s+)?[A-Z][\w&.\-]*/,
  /\((?:[A-Z][\w&.\- ]{1,40}),?\s*(?:19|20)\d{2}\)/, // (Gartner, 2024)
  /\[\d+\]|\[\w+ \d{4}\]/, // [1] or [Smith 2020]
  /\b[A-Z][a-z]+ et al\.?/,
  /\b(doi:|arxiv|pubmed|ISBN)\b/i,
];

export function findCitation(text) {
  for (const re of CITATION_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

// Split a line into sentences, keeping decimals ("3.5") and abbreviations intact.
export function splitSentences(line) {
  return line
    .replace(/\b(e\.g|i\.e|vs|etc|approx|inc|ltd|dr|mr|ms|no)\./gi, (m) => m.replace('.', '\u0000'))
    .split(/(?<=[.!?])\s+(?=["“A-Z0-9$€£])/)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length >= 8);
}

export function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const SUGGESTIONS = {
  headcount: 'Check against Crustdata headcount. Investors will look this up.',
  funding: 'Check the amount, round, date, and investors against Crustdata funding data.',
  founded: 'Check the founding year against Crustdata company records.',
  founder_background: 'Check founders’ past roles against their Crustdata employment history.',
  hiring: 'Check against open roles in Crustdata hiring data.',
  location: 'Check against Crustdata headquarters data.',
  growth: 'Growth figures should match Crustdata headcount and hiring trends where they overlap.',
  other: 'VeriDeck will search the web through Crustdata for a source.',
};

export function levelFor(risk) {
  if (risk >= 60) return 'high';
  if (risk >= 35) return 'medium';
  return 'low';
}

export function scoreClaim(types, citation) {
  const weights = types.map((t) => CATEGORIES[t]?.weight ?? 30).sort((a, b) => b - a);
  let risk = weights[0] + weights.slice(1).reduce((a, w) => a + w * 0.3, 0);
  if (citation) risk *= 0.5;
  return Math.round(Math.min(100, risk));
}

// One claim = one checkable fact in one category. `text` is the fact,
// `quote` the slide sentence it came from (often the same).
export function buildClaim(slide, text, category, extra = {}) {
  if (Array.isArray(category)) category = category[0];
  if (!CATEGORIES[category]) category = 'other';
  const quote = extra.quote ?? text;
  const citation = findCitation(quote);
  const risk = scoreClaim([category], citation);
  return {
    id: hashId(`${slide.index}|${category}|${text}`),
    sentenceId: hashId(`${slide.index}|${quote}`),
    slide: slide.index,
    slideTitle: slide.title,
    text,
    quote,
    types: [category],
    category,
    reasons: [CATEGORIES[category].label],
    risk,
    level: levelFor(risk),
    citation,
    suggestion: SUGGESTIONS[category],
    ...extra,
  };
}

export function analyzeSentence(sentence) {
  const types = RULES.filter((r) => r.test(sentence)).map((r) => r.type);
  return types.length ? types : null;
}

// Pattern-matching extraction: one claim per (sentence, category). Used on its
// own when Gemini is unavailable, and to catch anything Gemini missed.
export function extractClaims(slides) {
  const claims = [];
  const seen = new Set();
  for (const slide of slides) {
    for (const line of [...slide.lines, ...slide.notes.filter((n) => !/^(source|sources|ref)s?\s*[:\-–]/i.test(n))]) {
      for (const sentence of splitSentences(line)) {
        for (const type of analyzeSentence(sentence) ?? []) {
          const claim = buildClaim(slide, sentence, type, { extractedBy: 'pattern' });
          if (seen.has(claim.id)) continue;
          seen.add(claim.id);
          claims.push(claim);
        }
      }
    }
  }
  return claims;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9$%+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Categories that describe the same fact closely enough to count as a match.
const SAME_FACT = [new Set(['headcount', 'growth']), new Set(['growth', 'other']), new Set(['funding', 'other'])];
const compatible = (a, b) => a === b || SAME_FACT.some((g) => g.has(a) && g.has(b));

function overlaps(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const wa = new Set(x.split(' '));
  const wb = y.split(' ');
  return wb.filter((w) => wa.has(w)).length / Math.min(wa.size, wb.length) >= 0.6;
}

// Gemini's claims, plus any pattern-matched claim Gemini didn't cover
// (same slide, overlapping sentence, compatible category).
export function mergeClaims(primary, extra) {
  const out = [...primary];
  const ids = new Set(primary.map((c) => c.id));
  for (const h of extra) {
    if (ids.has(h.id)) continue;
    const covered = primary.some((g) => g.slide === h.slide && compatible(g.category, h.category) && (overlaps(g.quote, h.quote) || overlaps(g.text, h.quote)));
    if (!covered) {
      out.push(h);
      ids.add(h.id);
    }
  }
  return out.sort((a, b) => a.slide - b.slide);
}

const THIRD_PARTY = /(^|\.)(linkedin|crunchbase|twitter|x|github|youtube|google|medium|facebook|instagram|notion|docs\.google|pitchbook|techcrunch|ycombinator|calendly|example)\.[a-z.]+$/i;

function domainsIn(text) {
  const found = [];
  for (const m of text.matchAll(/\bhttps?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) found.push(m[1]);
  for (const m of text.matchAll(/(?<![@\w.\/])((?:[a-z0-9-]+\.)+(?:com|io|ai|co|dev|app|so|xyz|tech|org|net|inc))\b/gi)) found.push(m[1]);
  return found.map((d) => d.toLowerCase().replace(/^www\./, '')).filter((d) => !THIRD_PARTY.test(d));
}

// Best guess at which company the deck is about: a domain on the slides
// (then in speaker notes), and the title-slide name.
export function detectCompany(slides) {
  const domain = domainsIn(slides.flatMap((s) => s.lines).join('\n'))[0] ?? domainsIn(slides.flatMap((s) => s.notes).join('\n'))[0] ?? null;
  const title = slides[0]?.title ?? '';
  const name = title.split(/\s+[—–|:-]\s+|:\s+/)[0].replace(/\(.*?\)/g, '').trim() || null;
  return { name, domain };
}
