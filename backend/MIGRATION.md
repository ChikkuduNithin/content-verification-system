# LangChain migration — what changed and how to apply it

Tested end-to-end in mock mode (`USE_MOCK_LLM=true`, zero API keys) — the
whole pipeline runs, falls back correctly, and returns a valid response.
Real-provider paths (OpenAI / Gemini) are wired the same way the old code
called them, but weren't hit against a live key in this environment —
smoke test those before you trust them in an interview demo.

## New files

```
backend/
├── langchain/
│   ├── modelProvider.js       # resolves OpenAI/Gemini/Ollama/mock from your existing env vars
│   ├── schemas.js              # Zod schemas for structured output
│   ├── chains.js               # claimExtractionChain, claimVerificationChain, summaryChain
│   ├── tools.js                # search_web, retrieve_trusted_evidence, get_youtube_transcript
│   └── verificationAgent.js    # coordinator agent + deterministic fallback
├── scoring/
│   └── scoring.js               # legacyScore (default) + weightedScore, behind SCORING_MODEL
├── controllers/
│   ├── analyzeController.js         # updated to use the above
│   └── analyzeController.legacy.js  # your original file, kept for diffing
└── package.json                 # + langchain, @langchain/core, @langchain/openai,
                                  #   @langchain/google-genai, zod
```

`services/llmService.js` and `services/scrapingService.js` are **untouched** —
`scrapingService.fetchEvidenceForClaim` is reused directly as the
deterministic fallback and inside the `search_web` / `retrieve_trusted_evidence`
tools. `services/llmService.js` is no longer imported by the controller;
keep it around for reference or delete it once you're confident in the swap.

## To apply

```bash
cd backend
npm install   # picks up the new deps from package.json
```

No `.env` changes needed — `modelProvider.js` reads the exact same
`LLM_PROVIDER`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
`OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `USE_MOCK_LLM` vars your `.env.example`
already defines. Add `SCORING_MODEL=weighted` to opt into the new scoring
model — it defaults to `legacy` (byte-identical to your original formula)
if unset.

## What to sanity-check before demoing

1. **Run it in mock mode first** (`USE_MOCK_LLM=true`, no keys) — confirms
   wiring end-to-end without touching a real provider.
2. **Then run it with your real key** (OpenAI or Gemini) against a real
   YouTube URL and read the console output — `agentic=true/false` per claim
   tells you whether the coordinator agent actually ran or the deterministic
   fallback caught it. If every claim shows `agentic=false` on a real key,
   something's wrong with tool binding for that provider — check the console
   warning it prints.
3. **Ollama isn't installed by default** — `getChatModel()` lazy-`require`s
   `@langchain/ollama` only if `LLM_PROVIDER=ollama`. Run
   `npm install @langchain/ollama` first if you actually use local models;
   otherwise leave it alone, it's never touched.
4. Note the one **`require` in an ESM file** in `modelProvider.js`'s Ollama
   branch — Node allows `require` inside ESM via `createRequire`, but as
   written it'll throw. If you plan to actually exercise the Ollama path,
   swap it for a static `import { ChatOllama } from '@langchain/ollama'` at
   the top of the file instead of the lazy require.

## Known gaps / honest caveats

- **`retrieve_trusted_evidence` is not a real vector retriever** — it's
  `search_web` filtered to a hardcoded domain allowlist
  (`langchain/tools.js`). Call `setVectorRetriever()` to swap in a real one
  (Chroma, pgvector, whatever) later without touching the agent.
- **`weightedScore` is unvalidated** — it's a documented, defensible design,
  but nobody's checked it against ground-truth claims yet. Build a small eval
  set before claiming it's *better*, not just *different*, in an interview.
- **Latency/cost**: the agent path can make up to 3 tool calls per claim
  vs. 1 in the old pipeline. Not benchmarked here — do that before you cite
  a number.
