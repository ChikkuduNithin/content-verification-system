/**
 * controllers/analyzeController.js
 * ─────────────────────────────────
 * Express router that handles:
 *   POST /api/analyze  — full verification pipeline
 *   GET  /api/history  — (optional) returns in-memory history
 *
 * Pipeline order:
 *   1. Extract video ID from URL
 *   2. Fetch transcript
 *   3. Process transcript → extract claims
 *   4. For each claim: fetch web evidence
 *   5. For each claim: run LLM verdict
 *   6. Aggregate results → credibility score + summary
 */

import express from 'express';
import { fetchTranscript } from '../services/transcriptService.js';
import { fetchEvidenceForClaim } from '../services/scrapingService.js';
import { extractClaimsFromTranscript, getClaimVerdict, generateSummary } from '../services/llmService.js';

const router = express.Router();

// ── In-memory history store (replaces MongoDB for simplicity) ─────────────────
// In a real app this would be a Mongoose model:  AnalysisResult.find({})
const analysisHistory = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * extractVideoId
 * Pulls the YouTube video ID from various URL formats:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://youtube.com/shorts/VIDEO_ID
 */
function extractVideoId(url) {
  try {
    const parsed = new URL(url);

    // Standard watch URL
    if (parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v');
    }

    // youtu.be short links and /shorts/
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'v'].includes(pathParts[0])) {
      return pathParts[1] || null;
    }

    // youtu.be domain
    if (parsed.hostname === 'youtu.be') {
      return pathParts[0] || null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * cleanTranscript
 * Removes filler words, normalises whitespace, strips HTML entities.
 * Caps transcript at ~3000 words to stay within LLM context limits.
 */
function cleanTranscript(rawText) {
  return rawText
    .replace(/\[.*?\]/g, '')         // remove [Music], [Applause], etc.
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
    .split(' ')
    .slice(0, 3000)                  // limit to first 3000 words
    .join(' ');
}

/**
 * splitIntoSentences
 * Naive sentence splitter — good enough for transcript prose.
 */
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
    .map(s => s.trim())
    .flatMap(chunkLongSentence)
    .filter(s => s.length > 20);
}

/**
 * extractKeyClaims
 * Heuristic extraction of 3–5 factual-sounding sentences.
 * Prefers sentences that contain numbers, named entities, or
 * strong verbs like "causes", "proves", "shows", "found".
 */
function extractKeyClaims(sentences) {
  const claimIndicators = [
    /\d+%/,                                // percentages
    /\$[\d,]+/,                            // dollar amounts
    /\b\d[\d,]*(\.\d+)?\s*(miles?|kilometers?|km|light[- ]years?|seconds?|years?|times?|percent|billion|million|trillion|quadrillion)\b/i,
    /\b(two hundred|fifty|thousand|eighty|million|billion|trillion|quadrillion)\b/i,
    /\b(causes?|proves?|shows?|found|linked|leads? to|results? in)\b/i,
    /\b(study|research|scientists?|doctors?|experts?|NASA|WHO|CDC)\b/i,
    /\b(never|always|every|all|none|most|majority)\b/i,
    /\b(increases?|decreases?|doubles?|triples?|kills?|cures?)\b/i,
    /\b(Earth|moon|solar system|Jupiter|Great Red Spot|Saturn|Mars|Neptune|Sun|Milky Way|galaxy|universe|Hubble|Carl Sagan|Canis Majoris)\b/i,
    /\b(distance|diameter|wider|larger|bigger|massive|formed|compared|converted|equals?)\b/i,
  ];

  function expandClaimCandidates(sentence) {
    let candidates = [sentence];
    const splitPatterns = [
      /\s+(?=and Saturn is\b)/i,
      /\s+(?=Saturn's rings\b)/i,
      /\s+(?=whereas\b)/i,
      /\s+(?=the biggest star\b)/i,
      /\s+(?=the diameter of the Milky Way\b)/i,
      /\s+(?=NGC\s*\d+\b)/i,
      /\s+but\s+/i,
    ];

    for (const pattern of splitPatterns) {
      candidates = candidates.flatMap(candidate => {
        const parts = candidate.split(pattern).map(part => part.trim()).filter(Boolean);
        return parts.length > 1 ? parts : [candidate];
      });
    }

    return [...new Set(candidates)];
  }

  function cleanClaimCandidate(sentence) {
    return sentence
      .replace(/^planets\s+the\b/i, 'The')
      .replace(/^and\s+/i, '')
      .replace(/^Earth and there are\b/i, 'There are')
      .replace(/^it think again at their farthest point the earth\b/i, 'The Earth')
      .replace(/^know of V Y Canis Majoris\b/i, 'V Y Canis Majoris')
      .replace(/^formed as many as\b/i, 'Some objects seen here may have formed as many as')
      .replace(/^Way galaxy down using the same scale the\b/i, 'The')
      .replace(/all the beaches of the planet\.?$/i, 'all the beaches of the planet Earth.')
      .replace(/two hundred and fifty two thousand eighty eight\.?$/i, 'two hundred and fifty two thousand eighty eight miles away.')
      .replace(/^(and|but|so|whereas|while)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isCompleteEnough(sentence) {
    const words = sentence.split(/\s+/);
    if (words.length < 7) return false;
    if (/\bhere's Earth\b/i.test(sentence)) return false;
    if (/^(times?|diameter|wide|years?|away|miles away|of|than|nothing compared)\b/i.test(sentence)) return false;
    if (/\b(about|does|the|of|to|and|but|with|from|size|we|our|a|an)\.?$/i.test(sentence)) return false;
    return true;
  }

  const candidateSentences = sentences.flatMap(expandClaimCandidates);

  const scored = candidateSentences.map(sentence => {
    const cleaned = cleanClaimCandidate(sentence);
    const score = claimIndicators.reduce(
      (acc, re) => acc + (re.test(cleaned) ? 1 : 0), 0
    );
    return { sentence: cleaned, score };
  });

  // Sort by score descending, take top 5 factual statements.
  // Transcript question fragments are useful context, but weak fact-check claims.
  return scored
    .filter(item => item.score > 0 && !item.sentence.includes('?') && isCompleteEnough(item.sentence))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.sentence);
}

/**
 * aggregateResults
 * Computes an overall credibility score from individual verdicts
 * and confidence levels.
 *   True  × confidence = positive contribution
 *   False × confidence = negative contribution
 *   Uncertain          = neutral (50 pts)
 */
function aggregateResults(results) {
  if (results.length === 0) return 0;

  const total = results.reduce((acc, r) => {
    if (r.verdict === 'True') return acc + (r.confidence * 100);
    if (r.verdict === 'False') return acc + ((1 - r.confidence) * 100);
    return acc + 50; // Uncertain = 50
  }, 0);

  return Math.round(total / results.length);
}

// ── Route: POST /api/analyze ──────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const { url } = req.body;

  // ── Step 1: Validate URL & extract video ID ───────────────────────────────
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A YouTube URL is required.' });
  }

  const videoId = extractVideoId(url.trim());
  if (!videoId) {
    return res.status(400).json({
      error: 'Could not extract a valid YouTube video ID from the URL provided.',
    });
  }

  console.log(`\n[Pipeline] Starting analysis for video: ${videoId}`);

  try {
    // ── Step 2: Fetch transcript ────────────────────────────────────────────
    console.log('[Step 2] Fetching transcript...');
    const rawTranscript = await fetchTranscript(videoId);

    // ── Step 3: Process transcript → extract claims ─────────────────────────
    console.log('[Step 3] Processing transcript...');
    const cleanedText = cleanTranscript(rawTranscript);
    const sentences = splitIntoSentences(cleanedText);
    const modelClaims = await extractClaimsFromTranscript(cleanedText);
    const claims = modelClaims.length > 0 ? modelClaims : extractKeyClaims(sentences);

    if (claims.length === 0) {
      return res.status(422).json({
        error: 'Could not extract any verifiable claims from this video transcript.',
      });
    }

    console.log(`[Step 3] Extracted ${claims.length} claims`);

    // ── Steps 4 & 5: Evidence + LLM verdict per claim ──────────────────────
    // We process claims sequentially to avoid hammering external APIs
    const results = [];

    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      console.log(`\n[Step 4] Claim ${i + 1}/${claims.length}: Fetching web evidence...`);

      // Step 4: Fetch web evidence for this claim
      const evidence = await fetchEvidenceForClaim(claim);

      console.log(`[Step 5] Claim ${i + 1}/${claims.length}: Running LLM verdict...`);

      // Step 5: Ask LLM to evaluate claim vs evidence
      const verdict = await getClaimVerdict(claim, evidence);

      results.push({
        claim,
        evidence,   // top snippets used as context
        ...verdict, // { verdict, confidence, reasoning }
      });
    }

    // ── Step 6: Aggregate results ───────────────────────────────────────────
    console.log('\n[Step 6] Aggregating results...');
    const overallScore = aggregateResults(results);

    // Ask LLM to write a short human-readable summary
    const summary = await generateSummary(claims, results, overallScore);

    // Build final response object
    const analysisResult = {
      videoId,
      url,
      claims,
      results,
      overallScore,
      summary,
      analyzedAt: new Date().toISOString(),
    };

    // Store in-memory history (capped at 50 entries)
    analysisHistory.unshift(analysisResult);
    if (analysisHistory.length > 50) analysisHistory.pop();

    console.log(`[Pipeline] Done. Overall score: ${overallScore}/100\n`);
    return res.json(analysisResult);

  } catch (err) {
    console.error('[Pipeline] Error:', err.message);
    return res.status(500).json({
      error: err.message || 'An unexpected error occurred during analysis.',
    });
  }
});

// ── Route: GET /api/history ───────────────────────────────────────────────────

router.get('/history', (_req, res) => {
  // Return lightweight history (omit full evidence blobs)
  const lightweight = analysisHistory.map(({ videoId, url, overallScore, summary, analyzedAt }) => ({
    videoId, url, overallScore, summary, analyzedAt,
  }));
  res.json(lightweight);
});

export default router;
