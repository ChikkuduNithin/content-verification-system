/**
 * pipeline/claimExtractor.js
 * ──────────────────────────
 * Handles deterministic heuristic candidate extraction from transcripts.
 *
 * It cleans transcripts, splits them into sentences, and identifies
 * candidate factual statements using weighted indicator regex patterns.
 * Candidates are filtered to remove non-claims (questions, greetings,
 * jokes, opinions, ads, etc.), deduplicated, and ranked by their
 * heuristic score.
 */

const MAX_HEURISTIC_CANDIDATES = 15;

const INDICATOR_CATEGORIES = [
  {
    name: 'numeric/statistical',
    weight: 3,
    patterns: [
      /\b\d+(?:\.\d+)?%\b/,
      /\b\d+\s+percent\b/i,
      /\b\d+\s*(?:out of|in)\s*\d+\b/i,
      /\b\d+\/\d+\b/,
      /\b\d+(?:\.\d+)?x\b/i,
      /\b(?:double|triple|quadruple|fold)\b/i,
      /\b\d[\d,]*\s*(?:million|billion|trillion|quadrillion)\b/i,
      /\b(?:two hundred|fifty|thousand|eighty|million|billion|trillion|quadrillion)\b/i
    ]
  },
  {
    name: 'measurement/unit',
    weight: 2,
    patterns: [
      /\b\d[\d,]*(\.\d+)?\s*(?:miles?|kilometers?|km|meters?|light[- ]years?|inches|feet|yards|cm|mm)\b/i,
      /\b\d[\d,]*(\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|decades?|centuries?)\b/i,
      /\b\d[\d,]*(\.\d+)?\s*(?:kg|lbs?|grams?|pounds?|tons?|degrees?\s*(?:C|F|Celsius|Fahrenheit)|celcius|fahrenheit|hz|gb|mb|tb|watts?|volts?|v)\b/i
    ]
  },
  {
    name: 'money',
    weight: 2,
    patterns: [
      /\b[\$€£¥]\s*\d[\d,]*\b/,
      /\b\d[\d,]*\s*(?:dollars?|usd|euros?|pounds?|yen)\b/i
    ]
  },
  {
    name: 'dates',
    weight: 2,
    patterns: [
      /\b(?:in\s+)?(1[789]\d{2}|20\d{2})\b/,
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s+\d{4})?\b/i,
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/
    ]
  },
  {
    name: 'causal relationship',
    weight: 3,
    patterns: [
      /\b(?:causes?|proves?|shows?|leads? to|results? in|linked to|associated with|triggers?|responsible for|due to|because of)\b/i
    ]
  },
  {
    name: 'research/study attribution',
    weight: 2,
    patterns: [
      /\b(?:study|research|scientists?|doctors?|experts?|investigators?|analysts?|journal|clinical trial|meta-analysis)\b/i,
      /\b(?:Harvard|Oxford|Stanford|MIT|Cambridge|UCLA|NASA|WHO|CDC|FDA|NIH|UN|United Nations|Nature|Science|Lancet|New England Journal of Medicine)\b/i
    ]
  },
  {
    name: 'comparison',
    weight: 2,
    patterns: [
      /\b(?:compared to|in comparison with|relative to|than|as\s+\w+[-e]r\s+as)\b/i,
      /\b(?:faster|slower|bigger|smaller|larger|taller|shorter|warmer|colder|hotter|higher|lower|greater|fewer|lesser|wider|deeper)\b/i,
      /\b(?:fastest|slowest|biggest|smallest|largest|tallest|shortest|warmest|coldest|hottest|highest|lowest|greatest|widest|deepest)\b/i
    ]
  },
  {
    name: 'absolute/generalization',
    weight: 2,
    patterns: [
      /\b(?:never|always|every|all|none|most|majority|completely|entirely|solely|exclusive|exclusively)\b/i
    ]
  },
  {
    name: 'named entity',
    weight: 1,
    patterns: [
      /\b(?:Earth|Moon|Sun|Mars|Jupiter|Saturn|Venus|Mercury|Neptune|Uranus|Pluto|Milky Way|Andromeda|Hubble|James Webb|ChatGPT|GPT|AI|Bitcoin|Ethereum)\b/i,
      /(?<!^)\b[A-Z][a-zA-Z]+\b/
    ]
  },
  {
    name: 'strong factual indicator',
    weight: 1,
    patterns: [
      /\b(?:confirm(?:ed)?|verify(?:ed)?|proven|discover(?:ed)?|establish(?:ed)?|demonstrate(?:d)?|factual|reality|evidence|data|statistics?|remission|remit)\b/i,
      /\b(?:increases?|decreases?|doubles?|triples?|kills?|cures?)\b/i
    ]
  }
];

const REJECT_PATTERNS = [
  /\?/, // question
  /^(?:hello|welcome|hey|hi|good\s+(?:morning|afternoon|evening)|greetings)\b/i, // greeting
  /\b(?:haha|lol|kidding|just\s+kidding|punchline)\b/i, // joke
  /\b(?:I\s+think|I\s+believe|in\s+my\s+opinion|my\s+view|personally|feel\s+like|pretty\s+sure|probably|maybe|guess)\b/i, // opinion
  /\b(?:sponsor|sponsored|nordvpn|squarespace|audible|advertisement|promo|discount\s+code|check\s+out\s+the\s+link|link\s+in\s+the\s+description)\b/i, // ad
  /\b(?:subscribe|like\s+this\s+video|comment\s+below|support\s+me\s+on\s+patreon|patreon|follow\s+me|hit\s+that\s+subscribe\s+button|share\s+this\s+video)\b/i, // CTA
  /^\s*(?:so\s+yeah|that's\s+basically\s+it|you\s+know\s+what\s+I\s+mean|stuff\s+like\s+that|let's\s+get\s+into\s+it|hope\s+you\s+guys\s+like)\s*$/i // primarily filler
];

export function cleanTranscript(rawText) {
  return rawText
    .replace(/\[.*?\]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3000)
    .join(' ');
}

export function splitIntoSentences(text) {
  const MAX_WORDS_PER_CLAIM = 45;
  const OVERLAP_STEP = 25;
  function chunkLongSentence(sentence) {
    const words = sentence.split(/\s+/).filter(Boolean);
    if (words.length <= MAX_WORDS_PER_CLAIM) return [sentence];
    const chunks = [];
    for (let i = 0; i < words.length; i += OVERLAP_STEP) {
      chunks.push(words.slice(i, i + MAX_WORDS_PER_CLAIM).join(' '));
      if (i + MAX_WORDS_PER_CLAIM >= words.length) break;
    }
    return chunks;
  }
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .flatMap(chunkLongSentence)
    .filter((s) => s.length > 20);
}

// Single-word (or very short) leading fragments that indicate the sentence is a chunk
// continuation from a previous auto-caption sentence, not a real sentence start.
const LEADING_FRAGMENT_RE = /^(?:this|that|these|those|here|there|so|now|then|but|and|or|because|when|while|if|though|although|weather|suggest|stealth|number|fact|thing|way|time|today|recently|actually|basically|literally|essentially|apparently|supposedly|reportedly|interestingly|surprisingly|notably|importantly|specifically)\s+/i;

// Trailing phrases that indicate the chunk ended mid-sentence.
const TRAILING_FRAGMENT_RE = /\b(?:the|a|an|its|their|his|her|our|Air Force's?|US|United States|the world's|so|which|that|and|but|to|for|of|in|on|with|from|by|as|at|this|these|those|who|what|where|when|how|very|quite|just|also|even|already|still|yet|soon|later|then|enough|keep|own|more|less)\s*\.?\s*$/i;

/**
 * Strip leading orphan fragments and trailing incomplete phrases from heuristic candidates.
 * These appear when the 28-word chunker cuts mid-sentence in auto-captions.
 */
function cleanCandidateText(sentence) {
  return sentence
    .replace(LEADING_FRAGMENT_RE, '')
    .replace(TRAILING_FRAGMENT_RE, '')
    .trim();
}

function isCompleteEnough(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length < 7) return false;
  // Ends with a dangling preposition, article, or possessive
  if (TRAILING_FRAGMENT_RE.test(sentence)) return false;
  return true;
}

function shouldRejectCandidate(sentence) {
  if (!isCompleteEnough(sentence)) return true;
  for (const pattern of REJECT_PATTERNS) {
    if (pattern.test(sentence)) return true;
  }
  return false;
}

function scoreCandidate(sentence) {
  let heuristicScore = 0;
  const matchedIndicators = [];

  for (const category of INDICATOR_CATEGORIES) {
    for (const pattern of category.patterns) {
      if (pattern.test(sentence)) {
        heuristicScore += category.weight;
        matchedIndicators.push(category.name);
        break; // Only apply score once per category
      }
    }
  }

  return { heuristicScore, matchedIndicators };
}

function deduplicateCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const normalized = c.sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(c);
    }
  }
  return unique;
}

/**
 * Extracts and scores heuristic candidate claims from transcript text.
 * @param {string} rawTranscript - The raw transcript text.
 * @returns {Array<{sentence: string, heuristicScore: number, matchedIndicators: string[]}>}
 */
export function extractCandidates(rawTranscript) {
  const cleanedText = cleanTranscript(rawTranscript);
  const sentences = splitIntoSentences(cleanedText);
  
  let candidates = sentences
    .map(sentence => {
      const cleaned = cleanCandidateText(sentence);
      return { raw: sentence, cleaned };
    })
    .filter(({ cleaned }) => !shouldRejectCandidate(cleaned))
    .map(({ raw, cleaned }) => {
      const { heuristicScore, matchedIndicators } = scoreCandidate(cleaned);
      return { sentence: cleaned, rawSentence: raw, heuristicScore, matchedIndicators };
    })
    .filter(c => c.heuristicScore > 0);

  candidates = deduplicateCandidates(candidates);
  candidates.sort((a, b) => b.heuristicScore - a.heuristicScore);
  
  return candidates;
}

/**
 * Returns the top N candidate claims.
 */
export function getTopCandidates(candidates, limit = MAX_HEURISTIC_CANDIDATES) {
  return candidates.slice(0, limit);
}

/**
 * Formats candidates for the LLM prompt.
 */
export function formatCandidatesForLLM(topCandidates) {
  return topCandidates.map((c, idx) => `[${idx}] ${c.sentence}`).join('\n');
}

/**
 * Fallback to pure heuristic extraction if LLM fails.
 * Uses the cleaned sentence text so even fallback output is readable.
 */
export function getHeuristicFallbackClaims(candidates, limit = 5) {
  return candidates.slice(0, limit).map(c => ({
    claim: c.sentence,  // already cleaned by extractCandidates
    importance: 'medium',
    meta: {
      heuristicScore: c.heuristicScore,
      matchedIndicators: c.matchedIndicators,
      originalSentence: c.rawSentence || c.sentence,
      fallback: true
    }
  }));
}
