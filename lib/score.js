// Credibility score, shared by server and browser (served at /shared/score.js).
// Driven by Crustdata verdicts; a source you attach yourself also counts as support.
// Riskier claims weigh more.

export const VERDICT_SUPPORT = { verified: 1, partially_verified: 0.6, unverifiable: 0.2, contradicted: 0 };
export const NEGATIVE = new Set(['contradicted']);

export function claimSupport(claim, state = {}) {
  if (state.dismissed) return null;
  if (state.sources?.length) return 1;
  const verdict = state.verification?.verdict;
  if (verdict in VERDICT_SUPPORT) return VERDICT_SUPPORT[verdict];
  return claim.citation ? 0.4 : 0;
}

export function deckScore(claims, states = {}) {
  let total = 0;
  let supported = 0;
  const counts = {
    high: 0, medium: 0, low: 0, dismissed: 0,
    verified: 0, partially_verified: 0, contradicted: 0, unverifiable: 0, unchecked: 0,
    supported: 0, flagged: 0,
  };
  for (const c of claims) {
    const st = states[c.id] ?? {};
    const support = claimSupport(c, st);
    if (support === null) {
      counts.dismissed++;
      continue;
    }
    counts[c.level]++;
    const verdict = st.verification?.verdict;
    if (verdict) counts[verdict]++;
    else counts.unchecked++;
    if (support >= 0.8) counts.supported++;
    if (NEGATIVE.has(verdict) && !st.sources?.length) counts.flagged++;
    const weight = 0.5 + c.risk / 100;
    total += weight;
    supported += weight * support;
  }
  const score = total ? Math.round((supported / total) * 100) : 100;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, counts, active: claims.length - counts.dismissed };
}
