/**
 * langchain/chains.js
 * ───────────────────
 * Deterministic LLM steps, expressed as LCEL chains instead of hand-built
 * prompt strings + regex JSON parsing. "Deterministic" here means: given
 * the same claim/evidence, the chain always does the same thing — no
 * tool use, no branching. The one place that branches (evidence
 * gathering) lives in verificationAgent.js instead.
 *
 * Each export mirrors a function from the old services/llmService.js:
 *   extractClaimsFromTranscript → claimExtractionChain
 *   getClaimVerdict             → claimVerificationChain (+ citation filter)
 *   generateSummary             → summaryChain
 *
 * Mock mode (USE_MOCK_LLM=true) short-circuits before touching a real
 * model, same as before, so the app still runs with zero API keys.
 */

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { getChatModel, isMockMode } from './modelProvider.js';
import { ClaimExtractionSchema, ClaimVerdictSchema } from './schemas.js';

// ── Claim extraction ────────────────────────────────────────────────────────

const extractionPrompt = ChatPromptTemplate.fromMessages([
  ['system', `Extract atomic factual claims from YouTube transcript text.

Rules:
- Return 3 to 6 claims.
- Each claim must be self-contained and 8 to 25 words.
- Split compound claims into separate claims.
- Do not include questions, jokes, or incomplete fragments.
- Mark subjective predictions/opinions with isOpinion: true so they can be filtered out.
- Preserve important numbers, units, names, and comparisons.
- Rate each claim's importance (high/medium/low) to the video's core message.`],
  ['user', 'Transcript:\n{transcript}'],
]);

let extractionChain = null;
async function getExtractionChain() {
  if (!extractionChain) {
    const chatModel = await getChatModel({ temperature: 0.1 });
    extractionChain = extractionPrompt.pipe(
      chatModel.withStructuredOutput(ClaimExtractionSchema)
    );
  }
  return extractionChain;
}

/**
 * claimExtractionChain
 * @param {string} transcript
 * @returns {Promise<Array<{claim: string, importance: string}>>}
 *   Opinion and duplicate claims are filtered out before returning —
 *   downstream code only ever sees checkable, unique claims.
 */
export async function claimExtractionChain(transcript) {
  if (isMockMode()) return [];

  const trimmedTranscript = String(transcript || '').split(/\s+/).slice(0, 1800).join(' ');
  if (!trimmedTranscript) return [];

  try {
    const chain = await getExtractionChain();
    const { claims } = await chain.invoke({ transcript: trimmedTranscript });
    return dedupeAndFilterClaims(claims);
  } catch (err) {
    console.warn('  [chains] Claim extraction unavailable:', err.message);
    return [];
  }
}

function dedupeAndFilterClaims(claims) {
  const seen = new Set();
  const kept = [];
  for (const c of claims || []) {
    if (c.isOpinion) continue;
    const wordCount = c.claim.split(/\s+/).length;
    if (wordCount < 6 || wordCount > 30 || c.claim.includes('?')) continue;
    const key = c.claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ claim: c.claim.replace(/\s+/g, ' ').trim(), importance: c.importance });
  }
  return kept.slice(0, 5);
}

// ── Claim verification ──────────────────────────────────────────────────────

const verificationPrompt = ChatPromptTemplate.fromMessages([
  ['system', `You are a rigorous fact-checker with expertise in scientific literacy and media analysis.

Evaluate the CLAIM using ONLY the EVIDENCE provided below. Do not use prior knowledge.
Be skeptical of extraordinary claims. If evidence is weak or contradictory, choose "Uncertain".
In supporting_sources, list only the evidence indices you actually relied on — do not cite
evidence that doesn't directly bear on the claim.`],
  ['user', 'CLAIM: "{claim}"\n\nEVIDENCE:\n{evidenceText}'],
]);

let verificationChain = null;
async function getVerificationChain() {
  if (!verificationChain) {
    const chatModel = await getChatModel({ temperature: 0.2 });
    verificationChain = verificationPrompt.pipe(
      chatModel.withStructuredOutput(ClaimVerdictSchema)
    );
  }
  return verificationChain;
}

const MOCK_VERDICTS = [
  { verdict: 'Uncertain', confidence: 0.55, reasoning: 'Some observational studies support this claim but the effect size cited is not consistent across literature. Causality has not been firmly established.' },
  { verdict: 'False', confidence: 0.82, reasoning: 'The specific figure cited does not match findings from peer-reviewed studies. The claim appears to misrepresent or exaggerate the original research results.' },
  { verdict: 'True', confidence: 0.71, reasoning: 'Multiple peer-reviewed studies corroborate this claim, though the exact magnitude may vary by population and methodology.' },
  { verdict: 'Uncertain', confidence: 0.45, reasoning: 'Evidence is conflicting — some sources support the claim while others contradict it. More rigorous controlled trials are needed before a definitive verdict can be given.' },
  { verdict: 'False', confidence: 0.9, reasoning: 'This claim contradicts the scientific consensus and contains inaccurate attribution to an institution that has not published such findings.' },
];
let mockIndex = 0;

function formatEvidence(evidence) {
  return evidence.map((e, i) => `[${i}] Title: "${e.title}"\n    Snippet: "${e.snippet}"`).join('\n\n');
}

/**
 * citationFilter
 * Drops any supporting_sources index the model hallucinated (out of range,
 * or pointing at the synthetic "no relevant web evidence found" filler).
 * This is the one-line version of what the README calls "a citation
 * filter that drops any source not in the evidence set".
 */
function citationFilter(supportingSources, evidence) {
  return (supportingSources || []).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < evidence.length && evidence[i].url
  );
}

/**
 * claimVerificationChain
 * @param {string} claim
 * @param {Array<{title:string, snippet:string, url:string}>} evidence
 * @returns {Promise<{verdict:string, confidence:number, reasoning:string, supporting_sources:number[]}>}
 */
export async function claimVerificationChain(claim, evidence) {
  if (isMockMode()) {
    const mock = MOCK_VERDICTS[mockIndex % MOCK_VERDICTS.length];
    mockIndex += 1;
    await new Promise((r) => setTimeout(r, 300));
    return { ...mock, supporting_sources: evidence.length ? [0] : [] };
  }

  try {
    const chain = await getVerificationChain();
    const result = await chain.invoke({
      claim,
      evidenceText: formatEvidence(evidence),
    });
    return {
      ...result,
      supporting_sources: citationFilter(result.supporting_sources, evidence),
    };
  } catch (err) {
    console.error('  [chains] Claim verification error:', err.message);
    return fallbackVerdictFromEvidence(claim, evidence);
  }
}

function fallbackVerdictFromEvidence(claim, evidence) {
  return {
    verdict: 'Uncertain',
    confidence: 0.3,
    reasoning: `Automated verification was unavailable for this claim (${evidence.length} evidence item(s) retrieved but not evaluated).`,
    supporting_sources: [],
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

const summaryPrompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a media literacy expert. Write concise, neutral summaries of fact-check results. 2-3 sentences maximum. Do not be alarmist.'],
  ['user', 'Summarise these fact-check results in 2-3 sentences. Overall score: {overallScore}/100.\n\nResults:\n{claimSummary}'],
]);

let summaryChainImpl = null;
async function getSummaryChain() {
  if (!summaryChainImpl) {
    const chatModel = await getChatModel({ temperature: 0.4 });
    summaryChainImpl = summaryPrompt.pipe(chatModel).pipe(new StringOutputParser());
  }
  return summaryChainImpl;
}

/**
 * summaryChain
 * @param {string[]} claims
 * @param {Array<{verdict:string, confidence:number}>} results
 * @param {number} overallScore
 */
export async function summaryChain(claims, results, overallScore) {
  const safeResults = Array.isArray(results) ? results : [];
  const trueCount = safeResults.filter((r) => r?.verdict === 'True').length;
  const falseCount = safeResults.filter((r) => r?.verdict === 'False').length;
  const uncertainCount = safeResults.filter((r) => r?.verdict === 'Uncertain').length;

  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 200));
    let tone = 'mixed';
    if (overallScore >= 75) tone = 'mostly credible';
    else if (overallScore <= 35) tone = 'largely misleading';
    return `This video contains ${claims.length} key verifiable claims. ` +
      `Analysis found ${trueCount} supported, ${falseCount} disputed, and ${uncertainCount} inconclusive. ` +
      `Overall credibility is ${tone} (score: ${overallScore}/100). ` +
      `Viewers should exercise critical thinking and consult primary sources before acting on this content.`;
  }

  try {
    const claimSummary = safeResults
      .map((r, i) => {
        const claimText = Array.isArray(claims) && claims[i] ? claims[i] : `Claim #${i + 1}`;
        const verdict = r?.verdict || 'Uncertain';
        const conf = typeof r?.confidence === 'number' ? Math.round(r.confidence * 100) : 0;
        return `- "${claimText.slice(0, 80)}..." → ${verdict} (${conf}%)`;
      })
      .join('\n');

    const chain = await getSummaryChain();
    const text = await chain.invoke({ overallScore, claimSummary });
    return text.trim() || 'Summary unavailable.';
  } catch (err) {
    console.error('  [chains] Summary generation error:', err.message);
    return `Analysis complete. ${trueCount} of ${safeResults.length} claims were supported by evidence. Overall credibility score: ${overallScore}/100.`;
  }
}