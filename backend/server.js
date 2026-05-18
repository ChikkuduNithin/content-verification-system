/**
 * server.js
 * ─────────
 * Entry point for the YouTube Content Verification System backend.
 * Sets up Express, CORS, routes, and starts the HTTP server.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import analyzeRouter from './controllers/analyzeController.js';
import { getLLMMode } from './services/llmService.js';

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────

// Parse incoming JSON request bodies
app.use(express.json());

// Allow cross-origin requests from the Vite dev server (port 5173)
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
}));

// ── Routes ────────────────────────────────────────────────────────────────────

// Main analysis pipeline: POST /api/analyze
app.use('/api', analyzeRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 YouTube Verifier Backend running on http://localhost:${PORT}`);
  console.log(`   Mode: ${getLLMMode()}`);
  console.log(`   Transcript: ${process.env.USE_MOCK_TRANSCRIPT === 'true' ? '📄 Mock' : '🎬 YouTube API'}\n`);
});
