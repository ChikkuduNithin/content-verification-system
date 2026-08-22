/**
 * controllers/analyzeController.js
 * ─────────────────────────────────
 * Express router for video analysis.
 *
 * Exposes:
 *   POST /api/analyze
 *   GET  /api/history
 *
 * This controller handles HTTP request validation and status codes, delegating
 * the core business workflow to the verificationPipeline.
 */

import express from 'express';
import { runVerificationPipeline } from '../pipeline/verificationPipeline.js';
import Analysis from '../models/Analysis.js';

const router = express.Router();

// ── Route: POST /api/analyze ───────────────────────────────────────────────
router.post('/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A YouTube URL is required.' });
  }

  try {
    const analysisResult = await runVerificationPipeline({ url });
    
    // Store in MongoDB
    await Analysis.create(analysisResult);

    return res.json(analysisResult);
  } catch (err) {
    console.error('[Controller] Pipeline Error:', err.message);
    const statusCode = err.message.includes('valid YouTube video ID') ? 400 
                     : err.message.includes('extract any verifiable claims') ? 422 
                     : 500;
    return res.status(statusCode).json({ error: err.message || 'An unexpected error occurred during analysis.' });
  }
});

// ── Route: GET /api/history ────────────────────────────────────────────────
router.get('/history', async (_req, res) => {
  try {
    const history = await Analysis.find()
      .select('videoId url overallScore summary analyzedAt')
      .sort({ analyzedAt: -1 })
      .limit(50);
    res.json(history);
  } catch (err) {
    console.error('[Controller] History fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

export default router;
