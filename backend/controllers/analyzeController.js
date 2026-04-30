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
import { getClaimVerdict, generateSummary } from '../services/llmService.js';

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
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);    // discard very short fragments
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
    /\b(causes?|proves?|shows?|found|linked|leads? to|results? in)\b/i,
    /\b(study|research|scientists?|doctors?|experts?|NASA|WHO|CDC)\b/i,
    /\b(never|always|every|all|none|most|majority)\b/i,
    /\b(increases?|decreases?|doubles?|triples?|kills?|cures?)\b/i,
  ];

  const scored = sentences.map(sentence => {
    const score = claimIndicators.reduce(
      (acc, re) => acc + (re.test(sentence) ? 1 : 0), 0
    );
    return { sentence, score };
  });

  // Sort by score descending, take top 5
  return scored
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
    const claims = extractKeyClaims(sentences);

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
