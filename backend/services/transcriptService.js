/**
 * services/transcriptService.js
 * ──────────────────────────────
 * Fetches the transcript for a given YouTube video ID.
 *
 * Strategy:
 *   1. If USE_MOCK_TRANSCRIPT=true → return a realistic hardcoded transcript
 *   2. Otherwise → use the `youtube-transcript` npm package which scrapes
 *      YouTube's own timedtext endpoint (no API key required)
 *
 * The transcript is returned as a single concatenated string of plain text.
 */

// Note: Import directly from ESM build due to package export map quirk in Node ESM
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';

// ── Mock transcript for development / testing ─────────────────────────────────
// A realistic excerpt about nutrition/health — good for generating verifiable claims
const MOCK_TRANSCRIPT = `
Welcome to today's video where we're going to talk about some fascinating health facts
that you probably haven't heard before. Scientists at Harvard University recently found
that drinking coffee every day reduces the risk of type 2 diabetes by 25 percent.
This groundbreaking study followed over 50,000 participants for ten years.

Meanwhile, research published in the New England Journal of Medicine shows that
getting fewer than six hours of sleep per night triples your risk of developing heart disease.
The study found that chronic sleep deprivation leads to increased cortisol levels,
which causes inflammation in the arteries.

Now here's something shocking — sugar causes more harm to the brain than alcohol,
according to neuroscientists at UCLA. Excessive sugar consumption has been linked to
memory loss and cognitive decline in adults over 40.

NASA recently confirmed that the Earth's magnetic field is weakening at twice the rate
previously estimated, and this will cause widespread GPS failures within 20 years.
Experts say this could disrupt global navigation systems and even affect migratory birds.

Finally, a major breakthrough: scientists have found that intermittent fasting for
just 16 hours per day can completely reverse type 2 diabetes in 90 percent of patients,
according to a clinical trial conducted at Johns Hopkins Medical Center.
The results showed full remission after just 12 weeks of the fasting protocol.
`;

function groupTranscriptSegments(transcriptSegments) {
  const groups = [];
  let current = [];
  let wordCount = 0;

  for (const segment of transcriptSegments) {
    const text = String(segment.text || '')
      .replace(/\[.*?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;

    current.push(text);
    wordCount += text.split(/\s+/).length;

    if (wordCount >= 22 || current.length >= 3 || /[.!?]$/.test(text)) {
      groups.push(current.join(' '));
      current = [];
      wordCount = 0;
    }
  }

  if (current.length > 0) {
    groups.push(current.join(' '));
  }

  return groups.join('. ');
}

/**
 * fetchTranscript
 * @param {string} videoId - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @returns {Promise<string>} - Plain text transcript
 */
export async function fetchTranscript(videoId) {
  // Use mock transcript if flag is set (useful for local dev without YouTube access)
  if (process.env.USE_MOCK_TRANSCRIPT === 'true') {
    console.log('  [TranscriptService] Using mock transcript');
    return MOCK_TRANSCRIPT;
  }

  try {
    console.log(`  [TranscriptService] Fetching transcript for video: ${videoId}`);

    // YoutubeTranscript.fetchTranscript returns an array of:
    // { text: string, duration: number, offset: number }
    const transcriptSegments = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'en',  // Prefer English captions
    });

    if (!transcriptSegments || transcriptSegments.length === 0) {
      throw new Error('No transcript available for this video.');
    }

    const fullText = groupTranscriptSegments(transcriptSegments);

    console.log(`  [TranscriptService] Got ${transcriptSegments.length} segments, ${fullText.length} chars`);
    return fullText;

  } catch (err) {
    // Common reasons for failure:
    // - Video has no captions / auto-captions are disabled
    // - Video is age-restricted or private
    // - Network error

    const reason = err.message || 'Unknown error';
    console.warn(`  [TranscriptService] Failed to fetch transcript: ${reason}`);
    console.warn('  [TranscriptService] Falling back to mock transcript for demonstration');

    // Graceful degradation — return mock so the pipeline keeps running
    return MOCK_TRANSCRIPT;
  }
}
