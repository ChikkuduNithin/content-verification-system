/**
 * components/ResultsPanel.jsx
 * ────────────────────────────
 * Displays the full analysis result returned by the backend:
 *   - Overall credibility score (gauge)
 *   - Summary paragraph
 *   - Per-claim cards (verdict, confidence, reasoning, evidence)
 *   - Reset button to run another analysis
 */

import ClaimCard from './ClaimCard.jsx';

/**
 * scoreLabel / scoreClass
 * Maps a 0–100 score to a human label and CSS class
 */
function scoreLabel(score) {
  if (score >= 75) return { label: 'Credible', cls: 'score-high' };
  if (score >= 50) return { label: 'Mixed', cls: 'score-mid' };
  if (score >= 30) return { label: 'Questionable', cls: 'score-low' };
  return { label: 'Unreliable', cls: 'score-very-low' };
}

function ResultsPanel({ result, onReset }) {
  const { videoId, claims, results, overallScore, summary, analyzedAt } = result;
  const { label, cls } = scoreLabel(overallScore);

  const trueCount = results.filter(r => r.verdict === 'True').length;
  const falseCount = results.filter(r => r.verdict === 'False').length;
  const uncertainCount = results.filter(r => r.verdict === 'Uncertain').length;

  // Format the analysis timestamp
  const formattedDate = new Date(analyzedAt).toLocaleString();

  return (
    <section className="results-panel">
      {/* ── Hero Score Block ──────────────────────────────────── */}
      <div className={`score-hero ${cls}`}>
        <div className="score-left">
          <p className="score-eyebrow">Credibility Score</p>
          <div className="score-number">{overallScore}<span className="score-denom">/100</span></div>
          <div className="score-badge">{label}</div>
        </div>

        <div className="score-right">
          {/* Verdict tally */}
          <div className="verdict-tally">
            <div className="tally-item tally-true">
              <span className="tally-count">{trueCount}</span>
              <span className="tally-label">Supported</span>
            </div>
            <div className="tally-divider" />
            <div className="tally-item tally-uncertain">
              <span className="tally-count">{uncertainCount}</span>
              <span className="tally-label">Uncertain</span>
            </div>
            <div className="tally-divider" />
            <div className="tally-item tally-false">
              <span className="tally-count">{falseCount}</span>
              <span className="tally-label">Disputed</span>
            </div>
          </div>

          {/* Segmented bar */}
          <div className="verdict-bar" aria-label="Verdict distribution">
            {trueCount > 0 && (
              <div
                className="bar-segment bar-true"
                style={{ flex: trueCount }}
                title={`${trueCount} supported`}
              />
            )}
            {uncertainCount > 0 && (
              <div
                className="bar-segment bar-uncertain"
                style={{ flex: uncertainCount }}
                title={`${uncertainCount} uncertain`}
              />
            )}
            {falseCount > 0 && (
              <div
                className="bar-segment bar-false"
                style={{ flex: falseCount }}
                title={`${falseCount} disputed`}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Summary ──────────────────────────────────────────── */}
      <div className="summary-block">
        <h2 className="summary-heading">Analysis Summary</h2>
        <p className="summary-text">{summary}</p>
        <div className="summary-meta">
          <span>Video: <code>{videoId}</code></span>
          <span>·</span>
          <span>Analysed: {formattedDate}</span>
          <span>·</span>
          <span>{claims.length} claims checked</span>
        </div>
      </div>

      {/* ── Claim Cards ──────────────────────────────────────── */}
      <div className="claims-section">
        <h2 className="claims-heading">
          Claim-by-Claim Breakdown
          <span className="claims-count">{claims.length} claims</span>
        </h2>
        <div className="claims-list">
          {results.map((claimResult, i) => (
            <ClaimCard
              key={i}
              index={i + 1}
              claim={claims[i]}
              verdict={claimResult.verdict}
              confidence={claimResult.confidence}
              reasoning={claimResult.reasoning}
              evidence={claimResult.evidence}
            />
          ))}
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────────── */}
      <div className="results-actions">
        <button className="reset-btn" onClick={onReset}>
          ← Analyse Another Video
        </button>
        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="yt-link"
        >
          View Original Video ↗
        </a>
      </div>
    </section>
  );
}

export default ResultsPanel;
