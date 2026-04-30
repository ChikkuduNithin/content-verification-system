/**
 * services/scrapingService.js
 * ───────────────────────────
 * For each claim extracted from the transcript, this service:
 *   1. Converts the claim into a search query
 *   2. Sends the query to DuckDuckGo's HTML endpoint (no API key needed)
 *   3. Uses cheerio to parse out titles + snippets from top results
 *   4. Returns an array of { title, snippet, url } evidence objects
 *
 * Fallback: If scraping fails (network issues, rate limits, etc.),
 * the service returns a set of mock evidence so the pipeline continues.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

// ── Constants ─────────────────────────────────────────────────────────────────

const SEARCH_BASE_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 3;          // Top N results to extract per claim
const REQUEST_TIMEOUT_MS = 8000; // Bail out after 8 seconds

// Realistic browser User-Agent to avoid being blocked
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * buildSearchQuery
 * Trims punctuation and filler from the claim to create a clean search query.
 * E.g. "Scientists found that coffee reduces diabetes by 25%"
 *   → "Scientists found coffee reduces diabetes 25%"
 */
function buildSearchQuery(claim) {
  return claim
    .replace(/["""'']/g, '')          // remove quotation marks
    .replace(/\b(that|the|a|an|is|are|was|were|be|been|being)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);                    // DuckDuckGo handles ~120 chars well
}

/**
 * generateMockEvidence
 * Returns plausible-looking mock evidence when real scraping is unavailable.
 * Keeps the pipeline runnable in offline / rate-limited environments.
 */
function generateMockEvidence(claim) {
  const shortClaim = claim.slice(0, 60);
  return [
    {
      title: `Fact Check: "${shortClaim}..."`,
      snippet: `Researchers and fact-checkers have examined claims similar to this one. The evidence is mixed, with some studies supporting partial aspects while others raise methodological concerns about the data sources cited.`,
      url: 'https://example-factcheck.org/article/1',
    },
    {
      title: `Scientific Analysis: Health Claims Under Review`,
      snippet: `Multiple peer-reviewed studies have looked at this topic. Experts caution that correlation does not imply causation, and that sample sizes and study design matter significantly when interpreting such results.`,
      url: 'https://example-science.org/review/health-claims',
    },
    {
      title: `Medical Community Response to Viral Health Claims`,
      snippet: `Healthcare professionals urge caution when evaluating health information from non-peer-reviewed sources. Consult a qualified medical professional before making health decisions based on online content.`,
      url: 'https://example-health.org/viral-claims',
    },
  ];
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * fetchEvidenceForClaim
 * @param {string} claim - A factual sentence extracted from the transcript
 * @returns {Promise<Array<{ title: string, snippet: string, url: string }>>}
 */
export async function fetchEvidenceForClaim(claim) {
  const query = buildSearchQuery(claim);
  console.log(`  [ScrapingService] Query: "${query.slice(0, 80)}..."`);

  try {
    // ── Send POST to DuckDuckGo HTML endpoint ──────────────────────────────
    // DuckDuckGo's HTML interface is more scrape-friendly than Google
    const response = await axios.post(
      SEARCH_BASE_URL,
      new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
      {
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    // ── Parse HTML with cheerio ────────────────────────────────────────────
    const $ = cheerio.load(response.data);
    const results = [];

    // DuckDuckGo HTML results live inside .result__body divs
    // Each result has:
    //   .result__title  → anchor with title text
    //   .result__snippet → paragraph with snippet text
    //   .result__url    → span with the display URL

    $('.result__body').each((i, el) => {
      if (results.length >= MAX_RESULTS) return false; // cheerio's "break"

      const titleEl = $(el).find('.result__a');
      const snippetEl = $(el).find('.result__snippet');
      const urlEl = $(el).find('.result__url');

      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();
      const url = urlEl.text().trim() || titleEl.attr('href') || '';

      // Only include results with meaningful content
      if (title && snippet) {
        results.push({ title, snippet, url });
      }
    });

    if (results.length === 0) {
      console.warn('  [ScrapingService] No results parsed, using mock evidence');
      return generateMockEvidence(claim);
    }

    console.log(`  [ScrapingService] Got ${results.length} evidence results`);
    return results;

  } catch (err) {
    // Network error, timeout, or parsing failure — fall back gracefully
    console.warn(`  [ScrapingService] Scraping failed (${err.message}), using mock evidence`);
    return generateMockEvidence(claim);
  }
}
