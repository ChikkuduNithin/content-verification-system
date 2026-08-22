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
import { ClaimRefinementSchema, ClaimVerdictSchema, BatchClaimVerdictSchema } from './schemas.js';

// ── Claim extraction ────────────────────────────────────────────────────────

const refinementPrompt = ChatPromptTemplate.fromMessages([
  ['system', `You are a claim refinement model in a fact-checking system. The input contains candidate sentences from a video transcript. Your task is to extract and select the best checkable factual claims. 
  
CRITICAL RULES against hallucination:
1. DO NOT ADD EXTERNAL KNOWLEDGE. If a sentence is cut off or missing context, do NOT guess the missing words using your own knowledge. 
2. Preserve exact numbers, dates, and names EXACTLY as they appear. Never change "a week" to "two weeks" or "$24,000" to "$100,000".
3. If a claim is too incomplete to be verified based ONLY on the provided text, drop it entirely. Do not invent the missing context.

Other rules:
4. Keep only objectively checkable factual assertions. 
5. Reject opinions, predictions, jokes, advertisements, and subjective statements.
6. Make each claim self-contained using ONLY the information present in the candidates.
7. Return at most 5 final claims. Assign importance as high, medium, or low.`],
  ['user', 'CANDIDATE CLAIMS:\n{candidateClaims}'],
]);

let refinementChain = null;
async function getRefinementChain() {
  if (!refinementChain) {
    const chatModel = await getChatModel({ temperature: 0.1 });
    refinementChain = refinementPrompt.pipe(
      chatModel.withStructuredOutput(ClaimRefinementSchema)
    );
  }
  return refinementChain;
}

// Minimum candidates needed before we bother calling the LLM refinement step.
// Below this threshold the transcript is too thin for the model to add value —
// we fall back to heuristics directly.
const MIN_CANDIDATES_FOR_LLM = 3;

// Maximum ms to wait for the LLM refinement step before giving up.
const LLM_REFINEMENT_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// Parse the retryDelay seconds from a Gemini 429 error message.
function parse429RetryMs(errMessage) {
  const match = String(errMessage).match(/"retryDelay":"(\d+)s"/);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

const MAX_RETRY_WAIT_MS = 12_000; // Don't wait more than 12s for a single retry

/**
 * Invoke a LangChain chain with:
 *  - a hard timeout (never hang forever)
 *  - one automatic retry if the API returns 429 and the retry delay is ≤ MAX_RETRY_WAIT_MS
 */
async function invokeWithRetry(chain, input, timeoutMs, label) {
  const attempt = async () => withTimeout(chain.invoke(input), timeoutMs, label);
  try {
    return await attempt();
  } catch (err) {
    const is429 = String(err.message).includes('429');
    if (!is429) throw err;
    const waitMs = parse429RetryMs(err.message);
    if (waitMs && waitMs <= MAX_RETRY_WAIT_MS) {
      console.warn(`  [chains] Rate limited (429). Retrying in ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      return attempt(); // one retry — let it throw if it fails again
    }
    // Quota exhausted for a long period — don't block the pipeline
    throw new Error(`Rate limit quota exhausted (retry delay: ${waitMs ? waitMs / 1000 : '?'}s). Falling back.`);
  }
}

/**
 * claimExtractionChain
 * @param {string} candidateClaimsText
 * @param {Array} rawCandidates - The raw candidate objects to map metadata.
 * @returns {Promise<Array<{claim: string, importance: string, meta: object}>>}
 */
export async function claimExtractionChain(candidateClaimsText, rawCandidates) {
  if (isMockMode()) return [];
  if (!candidateClaimsText || !candidateClaimsText.trim()) return [];

  // Skip LLM when there are too few candidates — use heuristic fallback instead.
  if (rawCandidates.length < MIN_CANDIDATES_FOR_LLM) {
    console.warn(`  [chains] Only ${rawCandidates.length} candidate(s) — skipping LLM refinement (threshold: ${MIN_CANDIDATES_FOR_LLM}).`);
    return [];
  }

  try {
    const chain = await getRefinementChain();
    const { claims } = await invokeWithRetry(
      chain,
      { candidateClaims: candidateClaimsText },
      LLM_REFINEMENT_TIMEOUT_MS,
      'LLM claim refinement'
    );
    return dedupeAndFilterRefinedClaims(claims, rawCandidates);
  } catch (err) {
    console.warn('  [chains] Claim refinement unavailable:', err.message);
    return [];
  }
}

function dedupeAndFilterRefinedClaims(claims, rawCandidates) {
  const seen = new Set();
  const kept = [];
  for (const c of claims || []) {
    const idx = c.supportingCandidateIndex;
    if (typeof idx !== 'number' || idx < 0 || idx >= rawCandidates.length) continue;
    
    const wordCount = c.claim.split(/\s+/).length;
    if (wordCount < 6 || wordCount > 30 || c.claim.includes('?')) continue;
    
    const key = c.claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    
    kept.push({ 
      claim: c.claim.replace(/\s+/g, ' ').trim(), 
      importance: c.importance,
      meta: {
        heuristicScore: rawCandidates[idx].heuristicScore,
        matchedIndicators: rawCandidates[idx].matchedIndicators,
        originalSentence: rawCandidates[idx].sentence,
        candidateIndex: idx,
        fallback: false
      }
    });
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
    const result = await invokeWithRetry(
      chain,
      { claim, evidenceText: formatEvidence(evidence) },
      20_000,
      'Claim verification'
    );
    return {
      ...result,
      supporting_sources: citationFilter(result.supporting_sources, evidence),
    };
  } catch (err) {
    console.warn('  [chains] Claim verification falling back to heuristic:', err.message.slice(0, 80));
    return evidenceBasedFallbackVerdict(claim, evidence);
  }
}

// Stop words to exclude from keyword overlap scoring
const VERDICT_STOP_WORDS = new Set([
  'about','also','and','are','been','but','can','did','does','for','from',
  'had','has','have','into','just','not','only','our','out','that','the',
  'their','then','there','they','this','those','was','were','what','when',
  'where','which','while','who','will','with','you','your','very','more',
]);

/**
 * Heuristic evidence-based verdict when LLM is unavailable.
 * Scores keyword overlap between the claim and each evidence snippet,
 * producing a rough True/Uncertain verdict with a calibrated confidence.
 */
function evidenceBasedFallbackVerdict(claim, evidence) {
  const usable = evidence.filter(e => e.url && e.snippet && !e.title?.startsWith('No relevant'));
  if (usable.length === 0) {
    return {
      verdict: 'Uncertain',
      confidence: 0.2,
      reasoning: 'No web evidence was found for this claim. Manual verification is recommended.',
      supporting_sources: [],
    };
  }

  const claimWords = new Set(
    (claim.toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter(w => !VERDICT_STOP_WORDS.has(w))
  );

  let bestScore = 0;
  let bestIdx = 0;
  usable.forEach((ev, i) => {
    const evText = `${ev.title} ${ev.snippet}`.toLowerCase();
    let hits = 0;
    for (const word of claimWords) if (evText.includes(word)) hits++;
    if (hits > bestScore) { bestScore = hits; bestIdx = i; }
  });

  const overlap = claimWords.size > 0 ? bestScore / claimWords.size : 0;
  const originalIdx = evidence.indexOf(usable[bestIdx]);

  if (overlap >= 0.55) {
    return {
      verdict: 'Uncertain',
      confidence: 0.52,
      reasoning: `Web evidence appears relevant to this claim (keyword overlap: ${Math.round(overlap * 100)}%). AI verdict was unavailable — review the sources below to verify.`,
      supporting_sources: originalIdx >= 0 ? [originalIdx] : [],
    };
  }

  return {
    verdict: 'Uncertain',
    confidence: 0.28,
    reasoning: `Retrieved evidence does not closely match the claim's key terms (keyword overlap: ${Math.round(overlap * 100)}%). AI verdict was unavailable — manual verification is recommended.`,
    supporting_sources: [],
  };
}

// ── Batch claim verification ─────────────────────────────────────────────────
// Sends ALL claims + evidence to the LLM in a single call instead of N calls.
// For 5 claims this reduces verification from 5 LLM calls → 1.

const batchVerificationPrompt = ChatPromptTemplate.fromMessages([
  ['system', `You are a rigorous fact-checker. You will be given multiple claims, each with its own web evidence list. 
Evaluate each claim using ONLY the evidence provided for it. Do not use prior knowledge.
Be skeptical of extraordinary claims. If evidence is weak or contradictory, choose "Uncertain".
For supporting_sources, list only the 0-based indices into THAT claim's evidence list that you actually relied on.
Return exactly one verdict object per claim, using the claimIndex provided.`],
  ['user', '{allClaimsText}'],
]);

let batchVerificationChainImpl = null;
async function getBatchVerificationChain() {
  if (!batchVerificationChainImpl) {
    const chatModel = await getChatModel({ temperature: 0.1 });
    batchVerificationChainImpl = batchVerificationPrompt.pipe(
      chatModel.withStructuredOutput(BatchClaimVerdictSchema)
    );
  }
  return batchVerificationChainImpl;
}

function formatBatchInput(claimsWithEvidence) {
  return claimsWithEvidence.map(({ claim, evidence }, i) => {
    const evidenceText = evidence
      .map((e, j) => `  [${j}] "${e.title}"\n      ${e.snippet}`)
      .join('\n');
    return `CLAIM [${i}]: "${claim}"\nEVIDENCE:\n${evidenceText}`;
  }).join('\n\n---\n\n');
}

/**
 * batchClaimVerificationChain
 * Verifies all claims in one LLM call. Falls back to per-claim heuristic if LLM fails.
 *
 * @param {Array<{claim: string, evidence: Array<{title,snippet,url}>}>} claimsWithEvidence
 * @returns {Promise<Array<{verdict, confidence, reasoning, supporting_sources}>>}
 *   One result per input item, in order.
 */
export async function batchClaimVerificationChain(claimsWithEvidence) {
  if (isMockMode() || claimsWithEvidence.length === 0) {
    return claimsWithEvidence.map(({ claim, evidence }, i) => {
      if (isMockMode()) {
        const mock = MOCK_VERDICTS[(mockIndex + i) % MOCK_VERDICTS.length];
        return { ...mock, supporting_sources: evidence.length ? [0] : [] };
      }
      return evidenceBasedFallbackVerdict(claim, evidence);
    });
  }

  try {
    const chain = await getBatchVerificationChain();
    const allClaimsText = formatBatchInput(claimsWithEvidence);
    const { verdicts } = await invokeWithRetry(
      chain,
      { allClaimsText },
      45_000,
      'Batch claim verification'
    );

    // Build an ordered result array from the verdicts (LLM may return them in any order)
    const resultsByIndex = new Map(verdicts.map(v => [v.claimIndex, v]));
    return claimsWithEvidence.map(({ claim, evidence }, i) => {
      const v = resultsByIndex.get(i);
      if (!v) return evidenceBasedFallbackVerdict(claim, evidence);
      return {
        verdict: v.verdict,
        confidence: v.confidence,
        reasoning: v.reasoning,
        supporting_sources: citationFilter(v.supporting_sources, evidence),
      };
    });
  } catch (err) {
    console.warn('  [chains] Batch verification fell back to heuristic:', err.message.slice(0, 80));
    return claimsWithEvidence.map(({ claim, evidence }) =>
      evidenceBasedFallbackVerdict(claim, evidence)
    );
  }
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
    const text = await invokeWithRetry(
      chain,
      { overallScore, claimSummary },
      25_000,
      'Summary generation'
    );
    return text.trim() || 'Summary unavailable.';
  } catch (err) {
    console.error('  [chains] Summary generation error:', err.message);
    return `Analysis complete. ${trueCount} of ${safeResults.length} claims were supported by evidence. Overall credibility score: ${overallScore}/100.`;
  }
}