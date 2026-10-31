// "3 questions to ask the founder", built from the claims Crustdata contradicted
// (then partly verified, then unverifiable), highest stakes first. No API calls,
// so it works the same for live runs, replays, and exported reports.
// Shared by server/CLI and browser (served at /shared/questions.js).

const ASK = {
  headcount: 'How are you counting the team (full-time only, contractors, or planned hires)?',
  funding: 'Which rounds, amounts, and investors make up that figure, and can you share the cap table?',
  founded: 'What date are you counting as the founding, and what happened then?',
  founder_background: 'Can you walk us through that role, and who could confirm it?',
  hiring: 'Where are those roles posted, and what budget and timeline back the hiring plan?',
  location: 'Where is the team actually based today?',
  growth: 'What metric and time period is that growth based on?',
  other: 'What is the source for this, and can you share it?',
};

const RANK = { contradicted: 0, partially_verified: 1, unverifiable: 2 };

export function founderQuestions(claims, states = {}, max = 3) {
  return claims
    .map((c) => ({ c, v: states[c.id]?.verification, st: states[c.id] ?? {} }))
    .filter(({ v, st }) => v && v.verdict in RANK && !st.dismissed && !st.sources?.length)
    .sort((a, b) => RANK[a.v.verdict] - RANK[b.v.verdict] || b.c.risk - a.c.risk)
    .slice(0, max)
    .map(({ c, v }) => {
      // A bare number ("1", "-10.41") reads badly on its own; use the judge's reason then.
      const value = (v.crustdata_value ?? '').replace(/(-?\d+\.\d)\d{2,}/g, '$1');
      const reason = v.reason.replace(/\.$/, '');
      const shows = /[a-z]{3,}/i.test(value) ? `Crustdata shows ${value}` : `Crustdata says: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
      const said = c.text.replace(/[.!]+$/, '');
      const lead =
        v.verdict === 'contradicted'
          ? `Your deck says “${said}”, but ${shows}.`
          : v.verdict === 'partially_verified'
            ? `Your deck says “${said}”; Crustdata only partly supports it: ${reason}.`
            : `Your deck says “${said}”, and Crustdata could not confirm it.`;
      const src = v.sources?.[0];
      return {
        question: `${lead} ${ASK[c.category] ?? ASK.other}`,
        claimId: c.id,
        slide: c.slide,
        verdict: v.verdict,
        source: src ? { label: src.label, endpoint: src.endpoint, url: src.url ?? null } : null,
      };
    });
}
