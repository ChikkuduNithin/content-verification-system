# VeriTube — YouTube Content Verification System

A full-stack MERN-style application that extracts key factual claims from YouTube video transcripts and verifies them against web evidence using an LLM.

## Architecture

```
youtube-verifier/
├── backend/                    # Node.js + Express
│   ├── server.js               # Entry point, Express setup
│   ├── controllers/
│   │   └── analyzeController.js  # Pipeline orchestrator + routes
│   ├── services/
│   │   ├── transcriptService.js  # Fetches YouTube transcript
│   │   ├── scrapingService.js    # Fetches web evidence per claim
│   │   └── llmService.js         # OpenAI GPT calls + mock
│   ├── .env.example
│   └── package.json
│
└── frontend/                   # React + Vite
    ├── src/
    │   ├── App.jsx             # Root, state management
    │   ├── App.css             # All styles (dark industrial theme)
    │   ├── main.jsx            # ReactDOM entry
    │   └── components/
    │       ├── UrlInput.jsx    # URL form with validation
    │       ├── LoadingScreen.jsx  # Animated pipeline progress
    │       ├── ResultsPanel.jsx   # Score + summary display
    │       └── ClaimCard.jsx   # Per-claim verdict card
    ├── index.html
    ├── vite.config.js
    └── package.json
```

## Pipeline (8 Steps)

```
URL Input
   ↓
1. Extract Video ID from URL
   ↓
2. Fetch Transcript (youtube-transcript npm / mock)
   ↓
3. Process Transcript
   → Clean text (strip filler, HTML entities, cap 3000 words)
   → Split into sentences
   → Score sentences by claim indicators (%, studies, named entities)
   → Extract top 3–5 claims
   ↓
4. For each claim → fetchEvidenceForClaim()
   → Build search query (strip filler words)
   → POST to DuckDuckGo HTML endpoint
   → Cheerio parses title + snippet from top 3 results
   ↓
5. For each claim → getClaimVerdict()
   → Send claim + evidence to GPT-4o-mini
   → Receive JSON: { verdict, confidence, reasoning }
   ↓
6. Aggregate Results
   → True × confidence → positive score
   → False × (1 - confidence) → partial score
   → Uncertain → 50 points
   → Average → overallScore (0–100)
   ↓
7. generateSummary()
   → LLM writes 2–3 sentence human summary
   ↓
8. Return to Frontend
```

## Quick Start

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — set USE_MOCK_LLM=true to skip OpenAI key requirement
node server.js
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

## Environment Variables

| Variable             | Default | Description                                      |
|----------------------|---------|--------------------------------------------------|
| `PORT`               | 5000    | Backend server port                              |
| `OPENAI_API_KEY`     | —       | Your OpenAI API key                              |
| `USE_MOCK_LLM`       | true    | Skip OpenAI calls, use realistic mock responses  |
| `USE_MOCK_TRANSCRIPT`| false   | Skip YouTube fetch, use built-in sample transcript |

## API Reference

### POST /api/analyze

**Request:**
```json
{ "url": "https://www.youtube.com/watch?v=VIDEO_ID" }
```

**Response:**
```json
{
  "videoId": "VIDEO_ID",
  "url": "...",
  "claims": ["claim 1", "claim 2", "..."],
  "results": [
    {
      "claim": "...",
      "evidence": [
        { "title": "...", "snippet": "...", "url": "..." }
      ],
      "verdict": "True | False | Uncertain",
      "confidence": 0.82,
      "reasoning": "1-2 sentence explanation"
    }
  ],
  "overallScore": 55,
  "summary": "This video contains 5 verifiable claims...",
  "analyzedAt": "2024-01-15T10:30:00.000Z"
}
```

### GET /api/history

Returns lightweight history of past analyses (in-memory, resets on restart).

## Example LLM Prompt

```
SYSTEM:
  You are a rigorous fact-checker with expertise in scientific literacy
  and media analysis.

  Evaluate the CLAIM using ONLY the EVIDENCE provided. Do not use prior
  knowledge.

  Respond ONLY with a valid JSON object containing exactly:
    "verdict"    : "True", "False", or "Uncertain"
    "confidence" : 0.0–1.0
    "reasoning"  : 1-2 sentence explanation citing specific evidence

USER:
  CLAIM: "Scientists at Harvard University found that coffee reduces the
  risk of type 2 diabetes by 25 percent."

  EVIDENCE:
  [1] Title: "Coffee and Diabetes Risk - Harvard Health"
      Snippet: "A meta-analysis of 28 studies found both caffeinated and
                decaffeinated coffee associated with reduced diabetes risk..."
  [2] Title: "Can Coffee Really Prevent Diabetes?"
      Snippet: "While some observational studies suggest a protective effect,
                experts caution that correlation ≠ causation..."
```

**LLM Response:**
```json
{
  "verdict": "Uncertain",
  "confidence": 0.58,
  "reasoning": "Some meta-analyses support an association between coffee
    consumption and reduced diabetes risk, but the specific 25% figure
    is not consistently cited and causality remains unestablished."
}
```

## Scoring Formula

```
score = average over all claims of:
  if verdict == "True"      → confidence × 100
  if verdict == "False"     → (1 - confidence) × 100
  if verdict == "Uncertain" → 50

Range: 0–100
  75–100 → Credible
  50–74  → Mixed
  30–49  → Questionable
  0–29   → Unreliable
```

## Notes

- **No MongoDB required** — history is stored in-memory. Add Mongoose easily by replacing the `analysisHistory` array in `analyzeController.js`.
- **DuckDuckGo scraping** may be rate-limited. The service gracefully falls back to mock evidence.
- **youtube-transcript** works without an API key but requires the video to have captions enabled.
