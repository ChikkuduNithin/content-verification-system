/**
 * services/llmService.js
 * ───────────────────────
 * Handles all interactions with the LLM (OpenAI GPT-4o-mini by default).
 *
 * Two exported functions:
 *   getClaimVerdict(claim, evidence) → { verdict, confidence, reasoning }
 *   generateSummary(claims, results, overallScore) → string
 *
 * If USE_MOCK_LLM=true (or OPENAI_API_KEY is missing), realistic mock
 * responses are returned so the full pipeline works without an API key.
 *
 * ── Example prompt sent to LLM ────────────────────────────────────────────────
 *
 * SYSTEM:
 *   You are a rigorous fact-checker. Evaluate the CLAIM using only the
 *   EVIDENCE provided. Respond in JSON with keys:
 *     verdict    (string): "True", "False", or "Uncertain"
 *     confidence (number): 0.0–1.0
 *     reasoning  (string): 1–2 sentence explanation
 *
 * USER:
 *   CLAIM: "Coffee reduces the risk of type 2 diabetes by 25 percent."
 *
 *   EVIDENCE:
 *   [1] Title: "Coffee and Diabetes Risk - Harvard Health"
 *       Snippet: "A meta-analysis of 28 studies found that both caffeinated
 *                 and decaffeinated coffee were associated with reduced
 *                 diabetes risk..."
 *   [2] Title: "Can Coffee Really Prevent Diabetes?"
 *       Snippet: "While some observational studies suggest a protective
 *                 effect, experts caution that correlation ≠ causation..."
 */

import OpenAI from 'openai';

// ── OpenAI client (only instantiated if key is present) ───────────────────────
let openai = null;
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here') {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const USE_MOCK = process.env.USE_MOCK_LLM === 'true' || !openai;

// ── Mock response pool ────────────────────────────────────────────────────────
// A variety of realistic fact-check responses to rotate through
const MOCK_VERDICTS = [
  {
    verdict: 'Uncertain',
    confidence: 0.55,
    reasoning:
      'Some observational studies support this claim but the effect size cited is not consistent across literature. Causality has not been firmly established.',
  },
  {
    verdict: 'False',
    confidence: 0.82,
    reasoning:
      'The specific figure cited does not match findings from peer-reviewed studies. The claim appears to misrepresent or exaggerate the original research results.',
  },
  {
    verdict: 'True',
    confidence: 0.71,
    reasoning:
      'Multiple peer-reviewed studies corroborate this claim, though the exact magnitude may vary by population and methodology.',
  },
  {
    verdict: 'Uncertain',
    confidence: 0.45,
    reasoning:
      'Evidence is conflicting — some sources support the claim while others contradict it. More rigorous controlled trials are needed before a definitive verdict can be given.',
  },
  {
    verdict: 'False',
    confidence: 0.9,
    reasoning:
      'This claim contradicts the scientific consensus and contains inaccurate attribution to an institution that has not published such findings.',
  },
];

let mockIndex = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * buildClaimPrompt
 * Formats the claim + evidence into a structured prompt string.
 */
function buildClaimPrompt(claim, evidence) {
  const evidenceText = evidence
    .map((e, i) =>
      `[${i + 1}] Title: "${e.title}"\n    Snippet: "${e.snippet}"`
    )
    .join('\n\n');

  return `CLAIM: "${claim}"

EVIDENCE:
${evidenceText}`;
}

/**
 * parseJsonFromLLM
 * Safely extracts JSON from LLM output, stripping markdown fences if present.
 */
function parseJsonFromLLM(text) {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const json = JSON.parse(cleaned);

  // Validate expected fields
  if (!['True', 'False', 'Uncertain'].includes(json.verdict)) {
    json.verdict = 'Uncertain';
  }
  json.confidence = Math.min(1, Math.max(0, Number(json.confidence) || 0.5));
  json.reasoning = String(json.reasoning || '').slice(0, 500);

  return json;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * getClaimVerdict
 * Sends a claim + its web evidence to the LLM and receives a structured verdict.
 *
 * @param {string} claim
 * @param {Array<{ title: string, snippet: string }>} evidence
 * @returns {Promise<{ verdict: string, confidence: number, reasoning: string }>}
 */
export async function getClaimVerdict(claim, evidence) {
  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (USE_MOCK) {
    console.log('  [LLMService] Using mock verdict');
    // Rotate through mock responses to simulate variety
    const mock = MOCK_VERDICTS[mockIndex % MOCK_VERDICTS.length];
    mockIndex++;
    // Small artificial delay to mimic API latency
    await new Promise(r => setTimeout(r, 300));
    return mock;
  }

  // ── Real OpenAI call ───────────────────────────────────────────────────────
  try {
    const userPrompt = buildClaimPrompt(claim, evidence);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',          // Fast and cost-effective
      max_tokens: 256,
      temperature: 0.2,              // Low temp for consistent verdicts
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a rigorous fact-checker with expertise in scientific literacy and media analysis.

Evaluate the CLAIM using ONLY the EVIDENCE provided below. Do not use prior knowledge.

Respond ONLY with a valid JSON object (no markdown, no extra text) containing exactly these keys:
  "verdict"    : "True", "False", or "Uncertain"
  "confidence" : a number from 0.0 (no confidence) to 1.0 (fully certain)
  "reasoning"  : a 1-2 sentence explanation citing specific evidence

Be skeptical of extraordinary claims. If evidence is weak or contradictory, choose "Uncertain".`,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content || '{}';
    return parseJsonFromLLM(rawText);

  } catch (err) {
    console.error('  [LLMService] OpenAI error:', err.message);
    // Return a safe fallback so the pipeline doesn't crash
    return {
      verdict: 'Uncertain',
      confidence: 0.5,
      reasoning: 'LLM analysis unavailable due to an API error. Please check your API key and try again.',
    };
  }
}

/**
 * generateSummary
 * Produces a short human-readable summary of the overall verification result.
 *
 * @param {string[]} claims
 * @param {Array<{ verdict: string, confidence: number }>} results
 * @param {number} overallScore - 0–100
 * @returns {Promise<string>}
 */
export async function generateSummary(claims, results, overallScore) {
  const trueCount = results.filter(r => r.verdict === 'True').length;
  const falseCount = results.filter(r => r.verdict === 'False').length;
  const uncertainCount = results.filter(r => r.verdict === 'Uncertain').length;

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (USE_MOCK) {
    await new Promise(r => setTimeout(r, 200));

    let tone = 'mixed';
    if (overallScore >= 75) tone = 'mostly credible';
    else if (overallScore <= 35) tone = 'largely misleading';

    return `This video contains ${claims.length} key verifiable claims. ` +
      `Analysis found ${trueCount} supported, ${falseCount} disputed, and ${uncertainCount} inconclusive. ` +
      `Overall credibility is ${tone} (score: ${overallScore}/100). ` +
      `Viewers should exercise critical thinking and consult primary sources before acting on this content.`;
  }

  // ── Real OpenAI call ───────────────────────────────────────────────────────
  try {
    const claimSummary = results
      .map((r, i) => `- "${claims[i].slice(0, 80)}..." → ${r.verdict} (${Math.round(r.confidence * 100)}%)`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: 'You are a media literacy expert. Write concise, neutral summaries of fact-check results. 2-3 sentences maximum. Do not be alarmist.',
        },
        {
          role: 'user',
          content: `Summarise these fact-check results in 2-3 sentences. Overall score: ${overallScore}/100.\n\nResults:\n${claimSummary}`,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() || 'Summary unavailable.';

  } catch (err) {
    console.error('  [LLMService] Summary generation error:', err.message);
    return `Analysis complete. ${trueCount} of ${results.length} claims were supported by evidence. Overall credibility score: ${overallScore}/100.`;
  }
}
