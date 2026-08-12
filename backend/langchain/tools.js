/**
 * langchain/tools.js
 * ──────────────────
 * Tools for the coordinator agent in verificationAgent.js. Every tool
 * wraps a service that already existed — nothing here changes what a
 * search or a transcript fetch actually does, they're just exposed to
 * the agent with a schema so it can call them.
 *
 * search_web               → services/scrapingService.js (unchanged)
 * retrieve_trusted_evidence → domain-filtered evidence lookup. NOT a
 *                             real vector retriever today — it's the
 *                             same search, filtered to a trusted-domain
 *                             allowlist. Call setVectorRetriever() to
 *                             swap in a real one (e.g. a Chroma/pgvector
 *                             store) without touching the agent.
 * get_youtube_transcript   → services/transcriptService.js (unchanged)
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { fetchEvidenceForClaim } from '../services/scrapingService.js';
import { fetchTranscript } from '../services/transcriptService.js';

const TRUSTED_DOMAINS = [
  'wikipedia.org', 'reuters.com', 'apnews.com', 'bbc.com', 'nature.com',
  'nasa.gov', 'nih.gov', 'who.int', 'cdc.gov', '.edu', '.gov',
];

function isTrustedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return TRUSTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`) || host.includes(d));
  } catch {
    return false;
  }
}

// ── Swappable retriever hook ────────────────────────────────────────────────
// Default: filter the same search results down to a trusted-domain
// allowlist. Replace with a real retriever (must expose the same
// `(claim) => Promise<Array<{title, snippet, url}>>` shape) once one exists.
let trustedEvidenceRetriever = async (claim) => {
  const results = await fetchEvidenceForClaim(claim);
  const trusted = results.filter((r) => isTrustedUrl(r.url));
  return trusted.length > 0 ? trusted : results; // don't return nothing just because none were "trusted"
};

export function setVectorRetriever(retrieverFn) {
  trustedEvidenceRetriever = retrieverFn;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const searchWebTool = tool(
  async ({ query }) => {
    const results = await fetchEvidenceForClaim(query);
    return JSON.stringify(results);
  },
  {
    name: 'search_web',
    description: 'General web search for evidence relevant to a factual claim. Use this first.',
    schema: z.object({ query: z.string().describe('The claim or search query to look up.') }),
  }
);

export const retrieveTrustedEvidenceTool = tool(
  async ({ query }) => {
    const results = await trustedEvidenceRetriever(query);
    return JSON.stringify(results);
  },
  {
    name: 'retrieve_trusted_evidence',
    description:
      'Search restricted to trusted/authoritative sources (encyclopedias, wire services, .gov/.edu, ' +
      'major scientific outlets). Use this when search_web evidence is weak, thin, or low-authority — ' +
      'not as your first call.',
    schema: z.object({ query: z.string().describe('The claim to find authoritative evidence for.') }),
  }
);

export const getYoutubeTranscriptTool = tool(
  async ({ videoId }) => {
    const { text } = await fetchTranscript(videoId);
    return text.slice(0, 4000);
  },
  {
    name: 'get_youtube_transcript',
    description: 'Fetch the transcript text for a YouTube video by its video ID, for extra context around a claim.',
    schema: z.object({ videoId: z.string().describe('The YouTube video ID.') }),
  }
);

export const evidenceTools = [searchWebTool, retrieveTrustedEvidenceTool, getYoutubeTranscriptTool];
