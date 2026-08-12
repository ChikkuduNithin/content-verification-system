/**
 * langchain/schemas.js
 * ────────────────────
 * Zod schemas passed to .withStructuredOutput(). These replace the old
 * pattern of prompting "respond ONLY with valid JSON" and hand-parsing
 * the string — the model provider now enforces (or function-calls into)
 * this shape directly, so parseJsonFromLLM()-style defensive parsing is
 * no longer needed for these two calls.
 */

import { z } from 'zod';

export const ExtractedClaimSchema = z.object({
  claim: z.string().min(1).describe('A single, self-contained factual claim, 8-25 words.'),
  importance: z
    .enum(['high', 'medium', 'low'])
    .describe('How central this claim is to the video\'s core message.'),
  isOpinion: z
    .boolean()
    .describe('True if this is a subjective opinion/prediction rather than a checkable fact.'),
});

export const ClaimExtractionSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(8),
});

export const ClaimVerdictSchema = z.object({
  verdict: z.enum(['True', 'False', 'Uncertain']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(500),
  supporting_sources: z
    .array(z.number().int().min(0))
    .describe(
      'Indices (0-based) into the EVIDENCE list that this verdict actually relies on. ' +
      'Omit any evidence item not directly used.'
    ),
});
