/**
 * langchain/modelProvider.js
 * ──────────────────────────
 * Single place that resolves "which chat model do we actually talk to".
 * Reuses the exact same env vars as the old services/llmService.js so
 * .env files don't need to change: LLM_PROVIDER, OPENAI_API_KEY,
 * GEMINI_API_KEY / GOOGLE_API_KEY, OLLAMA_BASE_URL, OLLAMA_MODEL,
 * USE_MOCK_LLM.
 *
 * Every chain/agent in this app should get its model from here instead
 * of constructing a provider client directly — that's what makes the
 * provider swappable without touching chain logic.
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(serviceDir, '../.env') });

const apiKey = process.env.OPENAI_API_KEY?.trim();
const hasUsableApiKey = apiKey && apiKey !== 'your_openai_api_key_here';
const googleApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const hasUsableGoogleApiKey = Boolean(googleApiKey);
const configuredProvider = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
const forceMock = String(process.env.USE_MOCK_LLM).toLowerCase() === 'true';

// Ensure this fallback line is set to gemini-2.5-flash (or gemini-3.6-flash)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

export const LLM_PROVIDER = forceMock
  ? 'mock'
  : (configuredProvider || (hasUsableGoogleApiKey ? 'google' : (hasUsableApiKey ? 'openai' : 'ollama')));

export function isMockMode() {
  return LLM_PROVIDER === 'mock';
}

export function getProviderLabel() {
  switch (LLM_PROVIDER) {
    case 'mock': return 'Mock LLM';
    case 'google': return `Google Gemini (${GEMINI_MODEL})`;
    case 'ollama': return `Ollama (${OLLAMA_MODEL})`;
    case 'openai': return 'OpenAI (gpt-4o-mini)';
    default: return 'Unavailable';
  }
}

let cachedModel = null;

/**
 * getChatModel
 * Returns a LangChain chat model instance for the configured provider.
 * Cached — chains/agents share one client instead of building a new
 * one per request.
 *
 * @param {{ temperature?: number }} [opts]
 */
export async function getChatModel({ temperature = 0.2 } = {}) {
  if (isMockMode()) {
    throw new Error(
      'getChatModel() should not be called in mock mode — chains and the ' +
      'agent short-circuit before touching a real model. See isMockMode().'
    );
  }

  if (cachedModel && cachedModel.__temperature === temperature) return cachedModel;

  let model;
  if (LLM_PROVIDER === 'google') {
    if (!hasUsableGoogleApiKey) throw new Error('Google provider selected, but GEMINI_API_KEY is missing.');
    model = new ChatGoogleGenerativeAI({ apiKey: googleApiKey, model: GEMINI_MODEL, temperature });
  } else if (LLM_PROVIDER === 'ollama') {
    // Dynamic ESM import to prevent "require is not defined" error in Node ESM mode
    const { ChatOllama } = await import('@langchain/ollama');
    model = new ChatOllama({ baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, temperature });
  } else {
    if (!hasUsableApiKey) throw new Error('OpenAI provider selected, but OPENAI_API_KEY is missing.');
    model = new ChatOpenAI({ apiKey, model: 'gpt-4o-mini', temperature });
  }

  model.__temperature = temperature;
  cachedModel = model;
  return model;
}