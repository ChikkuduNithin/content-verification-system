/**
 * server.js
 * ─────────
 * Entry point for the YouTube Content Verification System backend.
 * Sets up Express, CORS, routes, and starts the HTTP server.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import analyzeRouter from './controllers/analyzeController.js';
import { getProviderLabel } from './langchain/modelProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, '../frontend/dist');

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || 'mongodb://localhost:27017/youtube-verifier';

// ── Middleware ────────────────────────────────────────────────────────────────

// Parse incoming JSON request bodies
app.use(express.json());

// Enable CORS
app.use(cors());

// ── Routes ────────────────────────────────────────────────────────────────────

// Main analysis pipeline: POST /api/analyze
// History retrieval: GET /api/history (added in controller)
app.use('/api', analyzeRouter);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend static assets if built
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      return next();
    }
    const indexPath = path.join(frontendDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });
}

// ── Start Server ──────────────────────────────────────────────────────────────

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log(`📦 Connected to MongoDB (${MONGODB_URI.split('@').pop()})`);
    app.listen(PORT, () => {
      console.log(`\n🚀 YouTube Verifier Backend running on http://localhost:${PORT}`);
      console.log(`   Model Provider: ${getProviderLabel()}`);
      console.log(`   Transcript: ${process.env.USE_MOCK_TRANSCRIPT === 'true' ? '📄 Mock' : '🎬 YouTube API'}\n`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });
