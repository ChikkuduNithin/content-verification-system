/**
 * services/scrapingService.js
 *
 * Builds relevant web evidence for each extracted claim.
 * Primary source: DuckDuckGo HTML search.
 * Backup source: Gemini Grounding with Google Search, when GEMINI_API_KEY is set.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(serviceDir, '../.env') });

const SEARCH_BASE_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 3;
const REQUEST_TIMEOUT_MS = 8000;
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_API_BASE_URL = (process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

const USER_AGENT = 'Mozilla/5.0';

function buildSearchQuery(claim) {
  const lower = claim.toLowerCase();

  if (lower.includes('cgpa')) {
    const terms = ['CGPA'];
    if (/\b(shortlist|shortlisted|shortlisting)\b/i.test(claim)) terms.push('shortlisting');
    if (/\bplacement|placements|campus\b/i.test(claim)) terms.push('campus placements');
    if (/\bcompany|companies\b/i.test(claim)) terms.push('companies');
    if (/\bminimum|criteria|cutoff|cut-off\b/i.test(claim)) terms.push('minimum criteria');
    if (/\bonline assessment|assessment\b/i.test(claim)) terms.push('online assessment');
    if (/\binterview|interviews\b/i.test(claim)) terms.push('interviews');
    if (/\bstartup|startups\b/i.test(claim)) terms.push('startups');
    return [...new Set(terms)].join(' ');
  }

  if (/\bproof of work|projects?|internships?|experience\b/i.test(claim)) {
    return 'proof of work projects internship experience hiring recruiters';
  }

  const stopWords = new Set([
    'about', 'again', 'also', 'and', 'are', 'because', 'been', 'being', 'but',
    'can', 'could', 'did', 'does', 'for', 'from', 'had', 'has', 'have', 'how',
    'into', 'just', 'know', 'like', 'make', 'most', 'not', 'only', 'our', 'out',
    'really', 'right', 'same', 'she', 'should', 'some', 'something', 'stuff',
    'that', 'the', 'their', 'then', 'there', 'they', 'this', 'those', 'through',
    'too', 'under', 'very', 'via', 'was', 'were', 'what', 'when', 'where',
    'which', 'while', 'who', 'will', 'with', 'you', 'your',
  ]);

  return [...new Set(claim.toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 10)
    .join(' ');
}

function generateNoEvidenceResult(claim) {
  return [
    {
      title: 'No relevant web evidence found',
      snippet: `Search did not return reliable evidence directly addressing this claim: "${claim.slice(0, 140)}".`,
      url: '',
    },
  ];
}

function getGeminiText(data) {
  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || '')
    .join('')
    .trim() || '';
}

function getGroundingSources(data) {
  return data.candidates?.[0]?.groundingMetadata?.groundingChunks
    ?.map(chunk => chunk.web)
    .filter(Boolean) || [];
}

async function fetchDuckDuckGoEvidence(query) {
  const response = await axios.get(SEARCH_BASE_URL, {
    params: { q: query, kl: 'us-en' },
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html',
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const $ = cheerio.load(response.data);
  const results = [];

  $('.result__body').each((i, el) => {
    if (results.length >= MAX_RESULTS) return false;

    const titleEl = $(el).find('.result__a');
    const snippetEl = $(el).find('.result__snippet');
    const urlEl = $(el).find('.result__url');

    const title = titleEl.text().trim();
    const snippet = snippetEl.text().trim();
    const url = urlEl.text().trim() || titleEl.attr('href') || '';

    if (title && snippet) {
      results.push({ title, snippet, url });
    }
  });

  return results;
}

async function fetchGroundedEvidenceForClaim(claim) {
  if (!GEMINI_API_KEY) return [];

  const url = new URL(`${GEMINI_API_BASE_URL}/models/${GEMINI_MODEL}:generateContent`);
  url.searchParams.set('key', GEMINI_API_KEY);

  const prompt = `Find current web evidence relevant to this claim.

Claim: "${claim}"

Write 2-3 concise sentences summarizing what the search results say. Focus only on evidence that directly helps verify or dispute the claim.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 320,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini grounding responded with ${response.status}: ${body.slice(0, 180)}`);
  }

  const data = await response.json();
  const summary = getGeminiText(data);
  const sources = getGroundingSources(data);

  if (!summary || sources.length === 0) return [];

  return sources.slice(0, MAX_RESULTS).map((source, index) => ({
    title: source.title || `Grounded source ${index + 1}`,
    snippet: summary,
    url: source.uri || '',
  }));
}

export async function fetchEvidenceForClaim(claim) {
  const query = buildSearchQuery(claim);
  console.log(`  [ScrapingService] Query: "${query.slice(0, 80)}..."`);

  try {
    const results = await fetchDuckDuckGoEvidence(query);
    if (results.length > 0) {
      console.log(`  [ScrapingService] Got ${results.length} DuckDuckGo evidence results`);
      return results;
    }
    console.warn('  [ScrapingService] No DuckDuckGo results parsed, trying Gemini grounding');
  } catch (err) {
    console.warn(`  [ScrapingService] DuckDuckGo scraping failed (${err.message}), trying Gemini grounding`);
  }

  try {
    const groundedResults = await fetchGroundedEvidenceForClaim(claim);
    if (groundedResults.length > 0) {
      console.log(`  [ScrapingService] Got ${groundedResults.length} grounded Google results`);
      return groundedResults;
    }
    console.warn('  [ScrapingService] Gemini grounding returned no sources');
  } catch (err) {
    console.warn(`  [ScrapingService] Gemini grounding failed (${err.message})`);
  }

  return generateNoEvidenceResult(claim);
}
