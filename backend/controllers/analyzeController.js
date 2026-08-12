/**
 * controllers/analyzeController.js
 * ─────────────────────────────────
 * Express router — same routes, same response contract as before:
 *   POST /api/analyze
 *   GET  /api/history
 *
 * What changed vs. the original:
 *   - Claim extraction, verdicts, and summary now run through LangChain
 *     chains (langchain/chains.js) with Zod-validated structured output
 *     instead of hand-parsed JSON strings.
 *   - Evidence gathering per claim goes through the coordinator agent
 *     (langchain/verificationAgent.js) instead of calling
 *     scrapingService directly — it decides whether to escalate to
 *     trusted sources, capped at 3 tool calls, with a deterministic
 *     fallback if the agent run fails.
 *   - Scoring is pluggable (scoring/scoring.js): legacy formula stays
 *     byte-identical and is still the default; SCORING_MODEL=weighted
 *     opts into the importance-weighted model.
 *
 * What didn't change: extractVideoId, cleanTranscript,
 * splitIntoSentences, extractKeyClaims (still the fallback if the LLM
 * extraction comes back empty), findTimestampForClaim — all pure,
 * deterministic, no reason to touch them. And the response shape:
 * every field the old API returned is still here, unchanged; new
 * fields (importance, supporting_sources, agentic, meta) are additive.
 */

import express from 'express';
import { fetchTranscript } from '../services/transcriptService.js';
import { claimExtractionChain, claimVerificationChain, summaryChain } from '../langchain/chains.js';
import { gatherEvidenceForClaim } from '../langchain/verificationAgent.js';
import { computeScore } from '../scoring/scoring.js';
import { getProviderLabel } from '../langchain/modelProvider.js';

const router = express.Router();

// ── In-memory history store (unchanged) ────────────────────────────────────
const analysisHistory = [];

// ── Helpers (unchanged from the original — deterministic, no LLM) ─────────

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

function cleanTranscript(rawText) {
  return rawText
    .replace(/\[.*?\]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3000)
    .join(' ');
}

function splitIntoSentences(text) {
  const MAX_WORDS_PER_CLAIM = 28;
  function chunkLongSentence(sentence) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_WORDS_PER_CLAIM) return [sentence];
    const chunks = [];
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_CLAIM) {
      chunks.push(words.slice(i, i + MAX_WORDS_PER_CLAIM).join(' '));
    }
    return chunks;
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .flatMap(chunkLongSentence)
    .filter((s) => s.length > 20);
}

function extractKeyClaims(sentences) {
  const claimIndicators = [
    /\d+%/,
    /\$[\d,]+/,
    /\b\d[\d,]*(\.\d+)?\s*(miles?|kilometers?|km|light[- ]years?|seconds?|years?|times?|percent|billion|million|trillion|quadrillion)\b/i,
    /\b(two hundred|fifty|thousand|eighty|million|billion|trillion|quadrillion)\b/i,
    /\b(causes?|proves?|shows?|found|linked|leads? to|results? in)\b/i,
    /\b(study|research|scientists?|doctors?|experts?|NASA|WHO|CDC)\b/i,
    /\b(never|always|every|all|none|most|majority)\b/i,
    /\b(increases?|decreases?|doubles?|triples?|kills?|cures?)\b/i,
    /\b(Earth|moon|solar system|Jupiter|Great Red Spot|Saturn|Mars|Neptune|Sun|Milky Way|galaxy|universe|Hubble|Carl Sagan|Canis Majoris)\b/i,
    /\b(distance|diameter|wider|larger|bigger|massive|formed|compared|converted|equals?)\b/i,
  ];

  function isCompleteEnough(sentence) {
    const words = sentence.split(/\s+/);
    if (words.length < 7) return false;
    if (/\b(about|does|the|of|to|and|but|with|from|size|we|our|a|an)\.?$/i.test(sentence)) return false;
    return true;
  }

  const scored = sentences.map((sentence) => {
    const score = claimIndicators.reduce((acc, re) => acc + (re.test(sentence) ? 1 : 0), 0);
    return { sentence, score };
  });

  return scored
    .filter((item) => item.score > 0 && !item.sentence.includes('?') && isCompleteEnough(item.sentence))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => ({ claim: item.sentence, importance: 'medium' }));
}

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

// ── Route: POST /api/analyze ────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A YouTube URL is required.' });
  }

  const videoId = extractVideoId(url.trim());
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract a valid YouTube video ID from the URL provided.' });
  }

  console.log(`\n[Pipeline] Starting analysis for video: ${videoId} (${getProviderLabel()})`);

  try {
    console.log('[Step 2] Fetching transcript...');
    const { text: rawTranscript, segments } = await fetchTranscript(videoId);

    console.log('[Step 3] Extracting claims...');
    const cleanedText = cleanTranscript(rawTranscript);
    const sentences = splitIntoSentences(cleanedText);
    const modelClaims = await claimExtractionChain(cleanedText);
    const structuredClaims = modelClaims.length > 0 ? modelClaims : extractKeyClaims(sentences);

    if (structuredClaims.length === 0) {
      return res.status(422).json({ error: 'Could not extract any verifiable claims from this video transcript.' });
    }

    const claims = structuredClaims.map((c) => c.claim);
    console.log(`[Step 3] Extracted ${claims.length} claims`);

    const results = [];
    let anyAgentic = false;

    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      console.log(`\n[Step 4] Claim ${i + 1}/${claims.length}: Gathering evidence...`);

      const { evidence, agentic } = await gatherEvidenceForClaim(claim);
      anyAgentic = anyAgentic || agentic;

      console.log(`[Step 5] Claim ${i + 1}/${claims.length}: Verifying (agentic=${agentic})...`);
      const verdict = await claimVerificationChain(claim, evidence);

      const timestamp = findTimestampForClaim(claim, segments);

      results.push({
        claim,
        evidence,
        timestamp,
        importance: structuredClaims[i].importance,
        agentic,
        ...verdict, // { verdict, confidence, reasoning, supporting_sources }
      });
    }

    console.log('\n[Step 6] Aggregating results...');
    const { score: overallScore, model: scoringModel } = computeScore(results, structuredClaims);
    const summary = await summaryChain(claims, results, overallScore);

    const analysisResult = {
      // ── unchanged fields ──
      videoId,
      url,
      claims,
      results,
      overallScore,
      summary,
      analyzedAt: new Date().toISOString(),
      // ── additive fields ──
      agentic: anyAgentic,
      meta: {
        scoringModel,
        llmProvider: getProviderLabel(),
      },
    };

    analysisHistory.unshift(analysisResult);
    if (analysisHistory.length > 50) analysisHistory.pop();

    console.log(`[Pipeline] Done. Overall score: ${overallScore}/100 (scoring=${scoringModel})\n`);
    return res.json(analysisResult);
  } catch (err) {
    console.error('[Pipeline] Error:', err.message);
    return res.status(500).json({ error: err.message || 'An unexpected error occurred during analysis.' });
  }
});

// ── Route: GET /api/history ─────────────────────────────────────────────────

router.get('/history', (_req, res) => {
  const lightweight = analysisHistory.map(({ videoId, url, overallScore, summary, analyzedAt }) => ({
    videoId, url, overallScore, summary, analyzedAt,
  }));
  res.json(lightweight);
});

export default router;
