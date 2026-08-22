/**
 * pipeline/verificationPipeline.js
 * ────────────────────────────────
 * Orchestrates the full YouTube content verification workflow.
 * Decouples the application logic from the HTTP controller.
 */

import { fetchTranscript } from '../services/transcriptService.js';
import { claimExtractionChain, batchClaimVerificationChain, summaryChain } from '../langchain/chains.js';
import { fetchEvidenceForClaim } from '../services/scrapingService.js';
import { computeScore } from '../scoring/scoring.js';
import { getProviderLabel } from '../langchain/modelProvider.js';
import { 
  extractCandidates, 
  getTopCandidates, 
  formatCandidatesForLLM, 
  getHeuristicFallbackClaims 
} from './claimExtractor.js';

/**
 * Extracts a YouTube video ID from various URL formats.
 */
function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('v')) return parsed.searchParams.get('v');
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'v'].includes(pathParts[0])) return pathParts[1] || null;
    if (parsed.hostname === 'youtu.be') return pathParts[0] || null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Finds the best-matching transcript segment for the claim and returns the offset in seconds.
 */
function findTimestampForClaim(claim, segments) {
  if (!segments || segments.length === 0) return 0;
  const avgDuration = segments.reduce((sum, s) => sum + s.duration, 0) / segments.length;
  const isMs = avgDuration > 100;
  const claimWords = claim.toLowerCase().match(/\w+/g) || [];
  if (claimWords.length === 0) return 0;

  let bestSegment = segments[0];
  let maxOverlap = -1;
  for (const seg of segments) {
    const segText = seg.text.toLowerCase();
    let overlap = 0;
    for (const word of claimWords) if (segText.includes(word)) overlap++;
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestSegment = seg;
    }
  }
  const rawOffset = bestSegment ? bestSegment.offset : 0;
  return isMs ? Math.round(rawOffset / 1000) : Math.round(rawOffset);
}

/**
 * Main application orchestrator for video analysis.
 * @param {Object} params
 * @param {string} params.url - The YouTube video URL
 * @returns {Promise<Object>} The structured analysis result
 */
export async function runVerificationPipeline({ url }) {
  const videoId = extractVideoId(url.trim());
  if (!videoId) {
    throw new Error('Could not extract a valid YouTube video ID from the URL provided.');
  }

  console.log(`\n[Pipeline] Starting analysis for video: ${videoId} (${getProviderLabel()})`);

  // Step 1: Fetch Transcript
  console.log('[Step 1] Fetching transcript...');
  const { text: rawTranscript, segments } = await fetchTranscript(videoId);

  // Step 2: Heuristic Claim Extraction
  console.log('[Step 2] Heuristic claim candidate extraction...');
  const allCandidates = extractCandidates(rawTranscript);
  const topCandidates = getTopCandidates(allCandidates, 15);
  
  console.log(`[Claim Extraction] Heuristic candidates: ${allCandidates.length}, top candidates: ${topCandidates.length}`);

  // Step 3: LLM Claim Refinement (skipped if too few candidates)
  console.log('[Step 3] LLM claim refinement...');
  const candidateClaimsText = formatCandidatesForLLM(topCandidates);
  let refinedClaims = await claimExtractionChain(candidateClaimsText, topCandidates);

  if (refinedClaims.length === 0 && topCandidates.length > 0) {
    console.warn('[Pipeline] LLM returned no claims. Falling back to heuristic candidates.');
    refinedClaims = getHeuristicFallbackClaims(topCandidates, 5);
  }

  if (refinedClaims.length === 0) {
    throw new Error('Could not extract any verifiable claims from this video transcript.');
  }

  const claims = refinedClaims.map((c) => c.claim);
  console.log(`[Claim Extraction] Final claims: ${claims.length}`);

  // Step 4: Gather evidence for all claims (direct DuckDuckGo — no LLM calls)
  console.log('\n[Step 4] Gathering evidence for all claims...');
  const evidenceResults = [];

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    console.log(`  [Evidence] Claim ${i + 1}/${claims.length}: "${claim.slice(0, 60)}..."`);
    const evidence = await fetchEvidenceForClaim(claim);
    evidenceResults.push({ claim, evidence });
  }

  // Step 5: Verify all claims in ONE batch LLM call (N calls → 1)
  console.log('\n[Step 5] Batch verifying all claims...');
  const verdicts = await batchClaimVerificationChain(
    evidenceResults.map(({ claim, evidence }) => ({ claim, evidence }))
  );

  const results = evidenceResults.map(({ claim, evidence }, i) => ({
    claim,
    evidence,
    timestamp: findTimestampForClaim(claim, segments),
    importance: refinedClaims[i].importance,
    agentic: false,
    ...verdicts[i],
  }));

  // Step 6: Scoring & Summary
  console.log('\n[Step 6] Aggregating results...');
  const { score: overallScore, model: scoringModel } = computeScore(results, refinedClaims);
  const summary = await summaryChain(claims, results, overallScore);

  const analysisResult = {
    // ── unchanged fields for API contract ──
    videoId,
    url,
    claims,
    results,
    overallScore,
    summary,
    analyzedAt: new Date().toISOString(),
    // ── additive fields ──
    agentic: false,
    meta: {
      scoringModel,
      llmProvider: getProviderLabel(),
      claimMetadata: refinedClaims.map(c => c.meta) // Include internal traceability
    },
  };

  console.log(`[Pipeline] Done. Overall score: ${overallScore}/100 (scoring=${scoringModel})\n`);
  return analysisResult;
}
