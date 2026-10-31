# VeriDeck

Verify the claims in a startup pitch deck against real company and people data.
VeriDeck pulls out claims about the company and its founders (headcount, funding,
founding year, founders' past jobs, hiring) and checks each one against
[Crustdata](https://docs.crustdata.com). Every verdict comes with a reason and a source.

## Setup

```sh
cp .env.example .env      # then fill in both keys
npm start                 # http://localhost:3000
```

| Variable | Needed for |
| - | - |
| `CRUSTDATA_API_KEY` | All verification (company, people, and web data) |
| `GEMINI_API_KEY` | Claim extraction and verdicts |
| `GEMINI_MODEL` | Optional. Defaults to the newest `gemini-*-flash` model your key can use |

Node 20.12+ and no dependencies. Without keys the app still opens decks and finds claims
by pattern matching, but it can't verify them.

## One-click / no-human-steps

- **UI:** paste a pitch (or drop a .pptx) and click **Verify pitch**. It extracts claims, resolves the company in
  Crustdata (domain filled in automatically), and verifies every claim, with live progress.
- **API:** `curl -s localhost:3000/api/check -H 'content-type: application/json' -d '{"text":"<pitch>"}'`
  returns claims, verdicts, reasons, and sources as JSON (send `accept: application/x-ndjson` for streamed progress).
- **CLI:** `node scripts/check.js samples/zepto.md` prints each claim with its verdict, reason, and evidence
  (`--json` for machine output, `--domain=x.com` to pin the company).

## How a check works

1. **Extract**: Gemini splits the deck into atomic claims (one fact each, with the source sentence),
   plus company name, domain, HQ, and founders. Pattern matching adds back anything Gemini missed.
2. **Resolve**: `POST /company/identify` (free) lists same-named companies; VeriDeck picks the one that
   fits the pitch (domain, founded year, team size, then HQ and founder names) and explains why.
3. **Collect evidence from Crustdata** (`authorization: Bearer …`, `x-api-version: 2025-11-01`):
   - `POST /company/enrich` with `basic_info, headcount, funding, hiring, people, locations, social_profiles`
     for the founding year, headcount and growth, funding total, rounds and investors, open roles, HQ, and founders.
   - `POST /person/search` by `crustdata_person_id` for the founders Crustdata lists, plus a name-and-company
     search for founders named in the deck, to get their employment history and education.
   - `POST /web/search/live` for claims outside those datasets (customers, revenue, growth), capped at
     6 per run because of the endpoint's 10 requests/minute limit.
4. **Judge**: Gemini compares each claim with the evidence only (no outside knowledge) and returns
   `verified`, `partially_verified`, `contradicted`, or `unverifiable`, with a reason, the deciding
   Crustdata value, and the IDs of the evidence it used.
5. **Enforce sourcing**: the server maps evidence IDs to sources (Crustdata endpoint, retrieval time,
   data freshness, and a link such as the company website, profile, Crunchbase, or web result).
   A verdict that cites no evidence is downgraded to `unverifiable`, and an unverifiable claim cites
   the Crustdata lookup that came back empty, so every verdict has a source.

## In the app

- **▶ Replay demo** replays the last good run instantly with no API calls (saved in `data/last-good-run.json`;
  a sample run is committed so it works on a fresh clone).
- **Questions to ask the founder** appear at the top of the results and the exported report: up to 3, built
  from contradicted claims first, each citing the Crustdata value and source.
- Upload `.pptx` (slides plus speaker notes), `.md`, or `.txt` (slides separated by `---`).
- See the Crustdata company snapshot, a credibility score, and the verdict, reason, and sources for
  each claim (expand "Crustdata data" to see the raw fields behind a verdict).
- Filter by verdict, flag sentences that extraction missed, dismiss non-claims, and attach your own sources.
- Export a Markdown report or JSON. Work is saved in the browser for each deck.

"Try a sample pitch" loads `samples/sample.md`, test claims about Retool (a company Crustdata's
docs use as an example) that mix true and false statements.

## Layout

```
server.js          HTTP server: /api/config, /api/analyze, /api/verify
lib/crustdata.js   Crustdata client (company enrich, person search, web search; retries 429s)
lib/gemini.js      Gemini generateContent with a JSON response schema
lib/verify.js      extraction → evidence → verdicts → source enforcement
lib/claims.js      pattern-matching fallback, claim categories, company detection
lib/score.js       credibility score (shared with the browser)
lib/pptx.js, zip.js  .pptx / text parsing with no dependencies
public/            frontend (vanilla JS)
test/              npm test (Crustdata and Gemini HTTP calls are mocked)
```
