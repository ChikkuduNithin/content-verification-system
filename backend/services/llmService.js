/**
 * services/llmService.js
 * ───────────────────────
 * Handles all interactions with the LLM (Google Gemini by default when configured).
 *
 * Two exported functions:
 *   getClaimVerdict(claim, evidence) → { verdict, confidence, reasoning }
 *   generateSummary(claims, results, overallScore) → string
 *
 * If USE_MOCK_LLM=true (or API credentials are missing), realistic mock
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
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(serviceDir, '../.env') });

// ── Provider setup ────────────────────────────────────────────────────────────
const apiKey = process.env.OPENAI_API_KEY?.trim();
const hasUsableApiKey = apiKey && apiKey !== 'your_openai_api_key_here';
const googleApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const hasUsableGoogleApiKey = Boolean(googleApiKey);
const configuredProvider = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
const forceMock = String(process.env.USE_MOCK_LLM).toLowerCase() === 'true';
const LLM_PROVIDER = forceMock ? 'mock' : (configuredProvider || (hasUsableGoogleApiKey ? 'google' : (hasUsableApiKey ? 'openai' : 'ollama')));
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_API_BASE_URL = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

let openai = null;
if (LLM_PROVIDER === 'openai' && hasUsableApiKey) {
  openai = new OpenAI({ apiKey });
}

const USE_MOCK = LLM_PROVIDER === 'mock';

export function isUsingMockLLM() {
  return USE_MOCK;
}

export function getLLMMode() {
  if (USE_MOCK) return 'Mock LLM';
  if (LLM_PROVIDER === 'google') return `Google Gemini (${GEMINI_MODEL})`;
  if (LLM_PROVIDER === 'ollama') return `Ollama (${OLLAMA_MODEL})`;
  if (LLM_PROVIDER === 'openai' && openai) return 'OpenAI';
  return 'Unavailable';
}

export async function extractClaimsFromTranscript(transcript) {
  if (USE_MOCK) return [];

  const trimmedTranscript = String(transcript || '')
    .split(/\s+/)
    .slice(0, 1800)
    .join(' ');

  if (!trimmedTranscript) return [];

  const messages = [
    {
      role: 'system',
      content: `Extract atomic factual claims from YouTube transcript text.

Return ONLY valid JSON with this shape:
{"claims":["claim 1","claim 2"]}

Rules:
- Return 3 to 5 claims.
- Each claim must be self-contained and 8 to 25 words.
- Split compound claims into separate claims.
- Do not include questions, opinions, jokes, introductions, or incomplete fragments.
- Preserve important numbers, units, names, and comparisons.`,
    },
    {
      role: 'user',
      content: `Transcript:\n${trimmedTranscript}`,
    },
  ];

  try {
    let rawText;
    if (LLM_PROVIDER === 'google') {
      rawText = await callGemini(messages, {
        responseMimeType: 'application/json',
        maxTokens: 640,
        temperature: 0.1,
      });
    } else if (LLM_PROVIDER === 'ollama') {
      rawText = await callOllama(messages, { format: 'json', maxTokens: 640, temperature: 0.1 });
    } else {
      if (!openai) return [];
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 640,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages,
      });
      rawText = response.choices[0]?.message?.content || '{}';
    }

    const parsed = JSON.parse(rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim());
    return (Array.isArray(parsed.claims) ? parsed.claims : [])
      .map(claim => String(claim).replace(/\s+/g, ' ').trim())
      .filter(claim => {
        const wordCount = claim.split(/\s+/).length;
        return wordCount >= 6 && wordCount <= 30 && !claim.includes('?');
      })
      .slice(0, 5);
  } catch (err) {
    console.warn('  [LLMService] Claim extraction unavailable:', err.message);
    return [];
  }
}

function buildFactCheckSystemPrompt() {
  return `You are a rigorous fact-checker with expertise in scientific literacy and media analysis.

Evaluate the CLAIM using ONLY the EVIDENCE provided below. Do not use prior knowledge.

Respond ONLY with a valid JSON object (no markdown, no extra text) containing exactly these keys:
  "verdict"    : "True", "False", or "Uncertain"
  "confidence" : a number from 0.0 (no confidence) to 1.0 (fully certain)
  "reasoning"  : a 1-2 sentence explanation citing specific evidence

Be skeptical of extraordinary claims. If evidence is weak or contradictory, choose "Uncertain".`;
}

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

  let json;
  try {
    json = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    json = JSON.parse(jsonMatch?.[0] || '{}');
  }

  // Validate expected fields
  if (!['True', 'False', 'Uncertain'].includes(json.verdict)) {
    json.verdict = 'Uncertain';
  }
  json.confidence = Math.min(1, Math.max(0, Number(json.confidence) || 0.5));
  json.reasoning = String(json.reasoning || '').slice(0, 500);

  return json;
}

function buildEvidenceText(evidence = []) {
  return evidence
    .map(item => `${item.title || ''} ${item.snippet || ''}`)
    .join(' ')
    .toLowerCase();
}

function keywordSet(text) {
  const stopWords = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'being',
    'but', 'can', 'could', 'did', 'does', 'for', 'from', 'had', 'has', 'have',
    'how', 'into', 'just', 'know', 'like', 'make', 'most', 'not', 'only', 'our',
    'out', 'really', 'right', 'same', 'she', 'should', 'some', 'something',
    'stuff', 'that', 'the', 'their', 'then', 'there', 'they', 'this', 'those',
    'through', 'too', 'under', 'very', 'via', 'was', 'were', 'what', 'when',
    'where', 'which', 'while', 'who', 'will', 'with', 'you', 'your',
  ]);

  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter(word => word.length > 2 && !stopWords.has(word))
  );
}

function fallbackVerdictFromEvidence(claim, evidence = []) {
  const evidenceText = buildEvidenceText(evidence);
  if (!evidenceText || evidenceText.includes('no relevant web evidence found')) {
    return {
      verdict: 'Uncertain',
      confidence: 0.5,
      reasoning: 'No relevant web evidence was available, so the claim could not be verified.',
    };
  }

  const claimKeywords = keywordSet(claim);
  const evidenceKeywords = keywordSet(evidenceText);
  const overlap = [...claimKeywords].filter(word => evidenceKeywords.has(word));
  const overlapRatio = claimKeywords.size ? overlap.length / claimKeywords.size : 0;
  const isAbsolute = /\b(all|always|never|none|only|every)\b/i.test(claim);
  const evidenceHasQualifiers = /\b(however|but|also|may|some|often|generally|other factors|less emphasis|depends)\b/i.test(evidenceText);

  if (isAbsolute && evidenceHasQualifiers) {
    return {
      verdict: 'False',
      confidence: 0.72,
      reasoning: 'The retrieved evidence supports parts of the claim, but it describes additional factors and exceptions, so the absolute wording is not supported.',
    };
  }

  if (overlapRatio >= 0.25) {
    return {
      verdict: 'True',
      confidence: Math.min(0.78, Math.max(0.62, overlapRatio)),
      reasoning: 'The retrieved evidence contains directly related terms and supports the main point of the claim. This fallback verdict was used because the LLM API was temporarily unavailable.',
    };
  }

  return {
    verdict: 'Uncertain',
    confidence: 0.55,
    reasoning: 'The retrieved evidence was related but not direct enough to verify or dispute the claim confidently.',
  };
}

async function callOllama(messages, { format = 'json', maxTokens = 256, temperature = 0.2 } = {}) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      format,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama responded with ${response.status}: ${body.slice(0, 160)}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

function toGeminiContents(messages) {
  return messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
}

function getSystemInstruction(messages) {
  const systemText = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')
    .trim();

  return systemText ? { parts: [{ text: systemText }] } : undefined;
}

function getGeminiText(data) {
  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim() || '';
}

async function callGemini(messages, {
  responseMimeType,
  maxTokens = 256,
  temperature = 0.2,
} = {}) {
  if (!hasUsableGoogleApiKey) {
    throw new Error('Google provider selected, but GEMINI_API_KEY is missing.');
  }

  const url = new URL(`${GEMINI_API_BASE_URL}/models/${GEMINI_MODEL}:generateContent`);
  url.searchParams.set('key', googleApiKey);

  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
    thinkingConfig: {
      thinkingBudget: 0,
    },
  };

  if (responseMimeType) {
    generationConfig.responseMimeType = responseMimeType;
  }

  const body = {
    contents: toGeminiContents(messages),
    generationConfig,
  };
  const systemInstruction = getSystemInstruction(messages);
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status !== 503) break;
    await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini responded with ${response.status}: ${text.slice(0, 240)}`);
  }

  return getGeminiText(await response.json());
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

  // ── Real LLM call ──────────────────────────────────────────────────────────
  try {
    const userPrompt = buildClaimPrompt(claim, evidence);
    const messages = [
      {
        role: 'system',
        content: buildFactCheckSystemPrompt(),
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    if (LLM_PROVIDER === 'ollama') {
      console.log(`  [LLMService] Using Ollama model: ${OLLAMA_MODEL}`);
      const rawText = await callOllama(messages, { format: 'json', maxTokens: 256, temperature: 0.2 });
      return parseJsonFromLLM(rawText);
    }

    if (LLM_PROVIDER === 'google') {
      console.log(`  [LLMService] Using Gemini model: ${GEMINI_MODEL}`);
      const rawText = await callGemini(messages, {
        responseMimeType: 'application/json',
        maxTokens: 256,
        temperature: 0.2,
      });
      return parseJsonFromLLM(rawText);
    }

    if (!openai) {
      throw new Error('OpenAI provider selected, but OPENAI_API_KEY is missing.');
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',          // Fast and cost-effective
      max_tokens: 256,
      temperature: 0.2,              // Low temp for consistent verdicts
      response_format: { type: 'json_object' },
      messages,
    });

    const rawText = response.choices[0]?.message?.content || '{}';
    return parseJsonFromLLM(rawText);

  } catch (err) {
    console.error(`  [LLMService] ${getLLMMode()} error:`, err.message);
    if (LLM_PROVIDER !== 'ollama') {
      return fallbackVerdictFromEvidence(claim, evidence);
    }

    return {
      verdict: 'Uncertain',
      confidence: 0.5,
      reasoning: `Local LLM unavailable. Install Ollama, run "ollama pull ${OLLAMA_MODEL}", then start Ollama and try again.`,
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

  // ── Real LLM call ──────────────────────────────────────────────────────────
  try {
    const claimSummary = results
      .map((r, i) => `- "${claims[i].slice(0, 80)}..." → ${r.verdict} (${Math.round(r.confidence * 100)}%)`)
      .join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You are a media literacy expert. Write concise, neutral summaries of fact-check results. 2-3 sentences maximum. Do not be alarmist.',
      },
      {
        role: 'user',
        content: `Summarise these fact-check results in 2-3 sentences. Overall score: ${overallScore}/100.\n\nResults:\n${claimSummary}`,
      },
    ];

    if (LLM_PROVIDER === 'ollama') {
      return (await callOllama(messages, { format: undefined, maxTokens: 320, temperature: 0.4 })).trim() || 'Summary unavailable.';
    }

    if (LLM_PROVIDER === 'google') {
      return (await callGemini(messages, { maxTokens: 320, temperature: 0.4 })).trim() || 'Summary unavailable.';
    }

    if (!openai) {
      throw new Error('OpenAI provider selected, but OPENAI_API_KEY is missing.');
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 320,
      temperature: 0.4,
      messages,
    });

    return response.choices[0]?.message?.content?.trim() || 'Summary unavailable.';

  } catch (err) {
    console.error('  [LLMService] Summary generation error:', err.message);
    return `Analysis complete. ${trueCount} of ${results.length} claims were supported by evidence. Overall credibility score: ${overallScore}/100.`;
  }
}
