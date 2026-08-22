# VeriTube: YouTube Content Verification System

VeriTube is a full-stack web application that automatically extracts, fact-checks, and summarizes factual claims from YouTube videos. It uses heuristic analysis to identify candidate claims from transcripts, LLMs to refine these claims, and agentic web search to gather evidence and render a verdict.

## Project Overview

The system takes a YouTube URL as input, retrieves its transcript, and executes a rigorous verification pipeline. It evaluates the credibility of the video's core statements against external evidence and provides an easy-to-understand credibility score.

## Architecture

```text
HTTP Request
     ↓
analyzeController.js
     ↓
verificationPipeline.js (Orchestrator)
     ↓
┌───────────────────────────────────────────┐
│ Verification Pipeline                     │
│                                           │
│ 1. Extract video ID                       │
│ 2. Fetch transcript                       │
│ 3. Clean & segment transcript             │
│ 4. Heuristic claim extraction             │
│ 5. LLM claim refinement                   │
│ 6. Evidence gathering agent               │
│ 7. Claim verification chain               │
│ 8. Score results                          │
│ 9. Generate summary                       │
└───────────────────────────────────────────┘
     ↓
Analysis Result
     ↓
HTTP Response
```

## Backend Structure

- `backend/controllers/analyzeController.js`: Thin HTTP controller. Validates the request, delegates to the pipeline, handles status codes, and maintains the analysis history.
- `backend/pipeline/verificationPipeline.js`: The main application orchestrator coordinating all internal workflows.
- `backend/pipeline/claimExtractor.js`: Deterministic extraction logic. Segments transcript sentences, scores them heuristically to find candidate claims, and deduplicates/ranks them.
- `backend/langchain/`: Houses all LLM interactions, tools, and chains.
  - `chains.js`: Contains LangChain LCEL chains for refining candidate claims into finalized checkable claims, verifying them against gathered evidence, and generating the final summary.
  - `verificationAgent.js`: The LangGraph ReAct agent responsible for executing evidence gathering tools.
  - `tools.js`: Definitions for `search_web` and `retrieve_trusted_evidence` tools.
  - `modelProvider.js`: Resolves the LLM provider (OpenAI, Gemini, Ollama, Mock) from environment variables.
  - `schemas.js`: Zod schemas for structured LLM outputs.
- `backend/services/`: External API interaction services.
  - `transcriptService.js`: Fetches YouTube transcripts (or returns a mock transcript for testing).
  - `scrapingService.js`: Executes DuckDuckGo web scraping or Gemini grounding to find evidence.
- `backend/scoring/scoring.js`: Calculates the final credibility score based on individual claim verdicts and confidence intervals.

## Claim Extraction

The claim extraction process is intentionally decoupled into two stages for precision and reliability:

1. **Heuristic Candidate Discovery**: The transcript is parsed and sentences are scored deterministically based on indicators like percentages, measurements, causal language, and attribution. The top candidates (e.g. up to 15) are passed to the next stage.
2. **LLM Semantic Refinement**: The LLM refines the provided candidates, filtering out subjectivity, resolving context, and emitting fully self-contained atomic claims (e.g. 3-5 claims). The system retains the mapping between the final refined claim and its original candidate source for traceability.

## Agentic Evidence Gathering

Once claims are extracted, the system uses a ReAct agent to search for evidence:
`search_web` ↓ `quality assessment` ↓ `trusted evidence escalation (if needed)`

The agent is scoped purely to finding evidence. It does **not** judge the claim. This separation ensures the fact-checking process itself remains predictable and isolated from the retrieval logic.

## Verification

Claim verification is performed by a dedicated chain that reviews a claim alongside the evidence provided by the agent. It returns a structured `True`, `False`, or `Uncertain` verdict, accompanied by a confidence score and a detailed reasoning.

## API

### `POST /api/analyze`
Analyzes a YouTube video.
**Request Body**: `{ "url": "https://www.youtube.com/watch?v=..." }`
**Response**: A structured JSON object containing the overall score, summary, and a list of verified claims with reasoning and timestamp markers.

### `GET /api/history`
Retrieves a lightweight summary of previously analyzed videos (in-memory).

## Environment Variables

The backend relies on the following `.env` configuration:
- `PORT`: Server port (default: 5000)
- `LLM_PROVIDER`: E.g. `google`, `openai`, `ollama`, `mock`
- `GOOGLE_API_KEY` or `GEMINI_API_KEY`: API key for Gemini.
- `OPENAI_API_KEY`: API key for OpenAI.
- `GEMINI_MODEL`: Model name (default: `gemini-flash-latest`)
- `SCORING_MODEL`: Scoring formula (`legacy` or `weighted`)
- `USE_MOCK_TRANSCRIPT`: `true`/`false` for testing without YouTube access.

## Running Locally

1. Install dependencies in the backend and frontend:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
2. Start the backend:
   ```bash
   cd backend
   npm run dev
   ```
3. Start the frontend:
   ```bash
   cd frontend
   npm run dev
   ```

## Design Decisions

- **Separation of Deterministic Logic and Agentic Roles**: We avoid creating a single massive ReAct agent to orchestrate the entire flow. Transcript fetching, segmentation, scoring, and candidate extraction are deterministic and fast. LLMs are only utilized when deep semantic understanding or reasoning is required (e.g., candidate refinement, verdict generation). This makes the pipeline more predictable, easier to debug, and cheaper to execute.
- **Traceability**: Refined claims inherently track their originating candidate sentence. This builds confidence in the system's outputs, preventing AI hallucination of claims not actually present in the source material.
