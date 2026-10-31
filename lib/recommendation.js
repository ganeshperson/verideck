// Recommendation badge for the top of the report, computed from existing results
// (no API calls). Shared by server and browser (served at /shared/recommendation.js).
//
// Rules, checked in this order:
//   Pass             trust score < 40, or 2+ contradicted claims
//   Take the meeting trust score >= 75 and no contradicted founder or funding claim
//   Dig deeper       everything else (score 40-74, or one contradiction)
// A contradicted claim the user backed with their own source doesn't count,
// matching how the trust score treats it.
import { deckScore } from './score.js';

const KEY_CATEGORIES = new Set(['founder_background', 'funding']);

export function recommendation(claims, states = {}) {
  const contradicted = claims.filter((c) => {
    const st = states[c.id] ?? {};
    return st.verification?.verdict === 'contradicted' && !st.dismissed && !st.sources?.length;
  });
  if (!claims.some((c) => states[c.id]?.verification && !states[c.id]?.dismissed)) return null; // nothing verified yet

  const { score } = deckScore(claims, states);
  const n = contradicted.length;
  const key = contradicted.filter((c) => KEY_CATEGORIES.has(c.category));
  const what = (list) => list.map((c) => `“${c.text.replace(/[.!]+$/, '')}”`).join(' and ');

  if (score < 40 || n >= 2) {
    return {
      decision: 'pass',
      label: 'Pass',
      score,
      reason: n >= 2 ? `${n} claims contradicted by Crustdata, including ${what(contradicted.slice(0, 2))}.` : `Trust score ${score} is below 40.`,
    };
  }
  if (score >= 75 && !key.length) {
    return {
      decision: 'take',
      label: 'Take the meeting',
      score,
      reason: n
        ? `Trust score ${score} with no founder or funding claim contradicted (1 minor contradiction: ${what(contradicted)}).`
        : `Trust score ${score} and no claim contradicted by Crustdata.`,
    };
  }
  return {
    decision: 'dig',
    label: 'Dig deeper',
    score,
    reason: key.length
      ? `A ${key[0].category === 'funding' ? 'funding' : 'founder'} claim was contradicted: ${what(key)}.`
      : n
        ? `1 claim contradicted by Crustdata: ${what(contradicted)}.`
        : `Trust score ${score} is between 40 and 74.`,
  };
}
