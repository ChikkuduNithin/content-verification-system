/**
 * scoring/scoring.js
 * ──────────────────
 * Two scoring models. `legacyScore` is a byte-identical port of the
 * original aggregateResults() from analyzeController.js — same numbers
 * in, same score out, always. It stays the default so nothing that
 * depended on the old scale silently changes.
 *
 * Known flaws in the legacy formula (documented, not fixed, so the
 * trade-off is explicit rather than silently patched):
 *   1. False@0.5 confidence and Uncertain both score 50 — a confidently
 *      split-the-difference "False" is indistinguishable from "we don't know".
 *   2. Verdicts collapse toward the middle at low confidence: True@0.1 (10)
 *      and False@0.1 (90) are near-opposite, but both barely move off Uncertain's
 *      50 for the *reader*, since nothing in the response says "low confidence"
 *      loudly enough.
 *   3. No weighting — a throwaway aside claim counts exactly as much toward
 *      the overall score as the video's central claim.
 *
 * `weightedScore` addresses #3 directly (importance-weighted average) and
 * softens #1/#2 by pulling low-confidence verdicts further toward 50 before
 * weighting, so an uncertain verdict actually reads as uncertain. It's
 * opt-in via SCORING_MODEL=weighted so it can be evaluated against a
 * ground-truth set before becoming the default.
 */

const IMPORTANCE_WEIGHT = { high: 1.5, medium: 1.0, low: 0.5 };

export function legacyScore(results) {
  if (results.length === 0) return 0;
  const total = results.reduce((acc, r) => {
    if (r.verdict === 'True') return acc + r.confidence * 100;
    if (r.verdict === 'False') return acc + (1 - r.confidence) * 100;
    return acc + 50; // Uncertain
  }, 0);
  return Math.round(total / results.length);
}

export function weightedScore(results, claims) {
  if (results.length === 0) return 0;

  let weightedTotal = 0;
  let weightTotal = 0;

  results.forEach((r, i) => {
    const importance = claims[i]?.importance || 'medium';
    const weight = IMPORTANCE_WEIGHT[importance] ?? 1.0;

    let raw;
    if (r.verdict === 'True') raw = r.confidence * 100;
    else if (r.verdict === 'False') raw = (1 - r.confidence) * 100;
    else raw = 50;

    // Pull low-confidence verdicts toward 50 so "uncertain" reads as uncertain
    // instead of silently averaging like a confident middling verdict.
    const pulledToward50 = 50 + (raw - 50) * r.confidence;

    weightedTotal += pulledToward50 * weight;
    weightTotal += weight;
  });

  return Math.round(weightedTotal / weightTotal);
}

/**
 * computeScore
 * @param {Array<{verdict:string, confidence:number}>} results
 * @param {Array<{importance?:string}>} claims - parallel array to results;
 *   plain strings (no importance) are fine too, weightedScore defaults to 'medium'.
 * @returns {{ score: number, model: 'legacy' | 'weighted' }}
 */
export function computeScore(results, claims) {
  const model = String(process.env.SCORING_MODEL || 'legacy').trim().toLowerCase();
  if (model === 'weighted') {
    return { score: weightedScore(results, claims), model: 'weighted' };
  }
  return { score: legacyScore(results), model: 'legacy' };
}
