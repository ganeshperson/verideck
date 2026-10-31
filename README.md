# VeriDeck

VeriDeck checks the claims in a startup pitch against real company and people data.
Paste a pitch or drop a `.pptx`, click once, and VeriDeck:

1. pulls out every factual claim about the company and its founders (headcount, funding,
   founding year, who the founders are and where they worked, hiring, HQ, product facts),
2. works out which company the pitch is about, even when many companies share the name,
3. checks each claim against [Crustdata](https://docs.crustdata.com) company, people, and web data, and
4. returns a verdict for every claim (**verified**, **partly verified**, **contradicted**, or
   **unverifiable**) with a reason and a source, plus up to three questions to ask the founder.

## How to run it

Needs Node 20.12+ and has no dependencies to install.

```sh
cp .env.example .env      # add CRUSTDATA_API_KEY and GEMINI_API_KEY
npm start                 # open http://localhost:3000
```

| Variable | Used for |
| - | - |
| `CRUSTDATA_API_KEY` | All verification (company, people, and web data) |
| `GEMINI_API_KEY` | Claim extraction and verdicts |
| `GEMINI_MODEL` | Optional. Pins one model; by default VeriDeck picks the newest Flash model your key can use and falls back when it's overloaded |

Three ways to use it, none of which needs a human step after the first click:

- **Web app:** paste a pitch (or drop a `.pptx`, `.md`, or `.txt`) and click **Verify pitch**. A progress list
  shows each stage. **▶ Replay demo** reopens the last good run instantly with no API calls; a sample run is
  committed in `data/last-good-run.json`, so it works on a fresh clone.
- **API:** `curl -s localhost:3000/api/check -H 'content-type: application/json' -d '{"text":"<pitch>"}'`
  returns claims, verdicts, reasons, sources, and the company snapshot as JSON. Send
  `accept: application/x-ndjson` to stream progress events instead.
- **CLI:** `node scripts/check.js samples/zepto.md` prints every claim with its verdict, reason, and evidence.
  Add `--json` for machine output or `--domain=example.com` to pin the company.

Run the tests with `npm test`.

Without keys the app still opens decks and finds claims by pattern matching, but it can't verify them.

## Architecture

```
 pitch (.pptx / text)
        │
        ▼
 1. Extract   Gemini splits the pitch into atomic claims, one fact each, with the slide
              sentence it came from; pattern matching adds back anything Gemini missed
        │
        ▼
 2. Resolve   Crustdata Identify lists every company with that name; VeriDeck scores them
              against the pitch (domain, founded year, team size, then HQ and founder names)
        │
        ▼
 3. Evidence  Crustdata Enrich (company record) ─┬─ People Search (founders' histories)
                                                └─ Web Search (product facts, customers)
        │
        ▼
 4. Judge     Gemini compares each claim with the evidence only, never its own knowledge
        │
        ▼
 5. Re-check  claims still unsettled get a Crustdata web search and are judged again
        │
        ▼
 6. Enforce   every verdict must cite evidence; a verdict without evidence is downgraded
              to unverifiable, and an unverifiable claim cites the lookup that came back empty
```

| File | Role |
| - | - |
| `server.js` | HTTP server: `/api/check` (one click, streamed), `/api/verify` (re-check with a corrected company), `/api/analyze`, `/api/replay`, `/api/config` |
| `lib/verify.js` | The pipeline: extraction, company resolution, evidence gathering, judging, source enforcement |
| `lib/crustdata.js` | Crustdata client: version header, timeouts, retries on 429 |
| `lib/gemini.js` | Gemini client with JSON-schema output, model fallback, and cooldown for overloaded models |
| `lib/claims.js` | Claim categories, pattern-matching extraction, merging with Gemini's claims |
| `lib/questions.js` | "Questions to ask the founder", built from contradicted claims first |
| `lib/score.js` | Credibility score, shared by the server and the browser |
| `lib/pptx.js`, `lib/zip.js` | `.pptx` reading (slides and speaker notes) with no dependencies |
| `public/` | The web app (vanilla JS, no build step) |
| `scripts/check.js` | Command-line checker |
| `samples/` | Test pitches: `zepto.md` (true claims) and `sample.md` / `sample.pptx` (Retool, with planted false claims) |

## Crustdata endpoints used

Every request sends `authorization: Bearer <key>` and `x-api-version: 2025-11-01`.

| Endpoint | What VeriDeck uses it for |
| - | - |
| `POST /company/identify` | Resolve the company name to candidate records (free), so same-named companies can be told apart |
| `POST /company/enrich` | The chosen company's record: founded year, headcount and growth, funding total, rounds and investors, open roles, HQ, social links. The `people` section (founders and executives) is fetched in a separate, time-limited call |
| `POST /person/search` | Founders' employment history and education: by Crustdata person ID, by name at the company's domain, or by "founder" title at the domain |
| `POST /web/search/live` | Claims the datasets don't cover, such as product facts, customers, and city-level HQ; capped at 6 searches per run to respect the 10 requests/minute limit |

## The service

**Who pays:** VCs, angel networks, and incubators. Every pitch they receive needs a first-pass
check before anyone spends partner time on it: is the team really that size, did they really raise
that round, did the founders really work where they say? Analysts spend 2–3 days per startup on
these checks, by hand, across company databases, professional profiles, and news.

VeriDeck does that first pass in a few minutes per pitch and leaves a trail: each verdict links to
the Crustdata record or web page behind it. It doesn't replace diligence. It tells the analyst which
claims are already confirmed and which three questions to ask the founder.

## Approaches we weighed

- **Pattern matching vs. an LLM for finding claims.** Patterns are fast and free but miss claims written
  in plain prose; Gemini catches those but sometimes skips claims or merges several into one. We use both:
  Gemini extracts atomic claims, and pattern matching adds back anything it missed.
- **Letting the LLM use its own knowledge vs. evidence only.** A model's memory is stale and can't be cited.
  The judge sees only Crustdata evidence, must cite evidence IDs for every verdict, and is downgraded to
  unverifiable if it doesn't.
- **Name lookup vs. resolve-then-enrich.** Enriching by name takes whatever Crustdata ranks first.
  Identify is free and returns all candidates, so we score them against the pitch and enrich only the
  winner, by its Crustdata ID.
- **One enrich call vs. split calls.** A single call with every section is simplest, but one slow section
  delays everything, so the slow `people` section is fetched separately.
- **One judging pass vs. two.** A second pass costs another Gemini call but settles claims the structured
  data can't, such as a city-level HQ when Crustdata only stores the country.

## What failed

- **Gemini overload.** The newest Gemini models regularly returned 503 "high demand", hung until timeout,
  or hit 429 rate limits; one verification stalled for over five minutes. VeriDeck now asks the API which
  models the key can use, tries the newest Flash models, then Flash-Lite, retries a 503 once, switches
  immediately on a timeout, and skips an overloaded model for five minutes.
- **Person enrich needs a profile URL.** `/person/enrich` only takes profile URLs, which a pitch rarely
  contains. Founders' histories come from `/person/search` instead, by person ID or by name at the
  company's domain.
- **Slow founder lookups.** For a large company, enrich with the `people` section took 74–99 seconds,
  while every other section returned in 1–2 seconds. `people` now has its own 25-second budget, and if it
  runs out, People Search finds the founders. Every Crustdata and Gemini request has a timeout.
- **The first version checked the wrong thing.** It was a generic slide fact-checker (statistics,
  superlatives, "studies show"). Investors need specific company and founder facts checked against real
  records, so we refocused on startup claims and Crustdata data.

## The hardest case

**Headcount tolerance.** Crustdata counts employees who have public professional profiles, so its
number usually runs a little below a company's real headcount. VeriDeck accepts a headcount claim within
±20% of Crustdata's total, treats "400+" as verified when the total is at least 400, and says in the reason
that modest undercounts are normal. Tighter, and honest founders get flagged; looser, and inflated claims
pass.

**Ambiguous company names.** "Zepto" returns 25 companies in Crustdata, and 8 of them tie at the top
confidence score: the Mumbai quick-commerce company, an Australian payments firm, a US LLC, and others.
Checking the wrong one would contradict true claims. VeriDeck scores each candidate against what the pitch
says (a matching domain, founded year, and team size), and when the top candidates are still close, it
fetches their HQ and checks whether the named founders work there. It shows which company it picked and
why, and lists the alternatives so a human can correct it.

## How we tested

- **17 automated tests** (`npm test`) cover `.pptx` and text parsing, claim extraction and merging, company
  resolution, the full Crustdata → Gemini pipeline against mocked HTTP (checking the exact headers and
  request bodies), the rule that every verdict has a reason and a source, Gemini model fallback, the founder
  questions, and the HTTP API.
- **Live runs on test pitches** with real Crustdata and Gemini calls:
  - `samples/zepto.md` (true claims): founded 2021, founders Aadit Palicha and Kaivalya Vohra, Mumbai HQ, and
    10-minute delivery all came back verified, through the web app driven by headless Chrome. One run found
    and verified 11 of 11 claims; a later run, on Flash-Lite during Gemini rate limits, found 8 and verified all 8.
  - `samples/sample.md` (Retool, with planted false claims): 15 claims, 11 verified, and both planted
    contradictions caught (50+ open roles vs. 1 opening, 30% headcount growth vs. −10.4%).
- **Browser checks** in headless Chrome: one-click verification, the company domain filled in automatically,
  every claim showing a verdict, reason, and source, filters resetting between decks, and Replay opening in
  under 100 ms with no API calls.

## What comes next

- **Resume checks for hiring:** the same claim → evidence → verdict pipeline, run on a candidate's resume
  against their employment history.
- **Supplier checks for compliance:** verify a vendor's stated size, location, founding date, and ownership
  before onboarding.
- **Automatic re-checks with Crustdata Watcher:** watch every company that has been checked, and re-verify
  its claims when headcount, funding, or leadership changes, so a verdict doesn't go stale after the pitch.
