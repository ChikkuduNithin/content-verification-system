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

export const RefinedClaimSchema = z.object({
  claim: z.string().min(1).describe('A single, self-contained factual claim refined from the candidate claims, 8-25 words.'),
  importance: z.enum(['high', 'medium', 'low']).describe('How central this claim is to the video\'s core message.'),
  supportingCandidateIndex: z.number().int().describe('The index of the candidate sentence from the CANDIDATE CLAIMS list that supports this claim.')
});

export const ClaimRefinementSchema = z.object({
  claims: z.array(RefinedClaimSchema).max(5),
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

// Used by batchClaimVerificationChain — verifies ALL claims in one LLM call.
export const SingleBatchVerdictSchema = z.object({
  claimIndex: z.number().int().min(0).describe('0-based index of the claim this verdict is for.'),
  verdict: z.enum(['True', 'False', 'Uncertain']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(400),
  supporting_sources: z
    .array(z.number().int().min(0))
    .describe('0-based indices into the EVIDENCE list for this claim only.'),
});

export const BatchClaimVerdictSchema = z.object({
  verdicts: z.array(SingleBatchVerdictSchema)
    .describe('One verdict object per claim, in the same order as provided.'),
});
