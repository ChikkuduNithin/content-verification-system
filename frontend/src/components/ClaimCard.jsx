/**
 * components/ClaimCard.jsx
 * ─────────────────────────
 * Displays a single verified claim with:
 *   - Verdict badge (True / False / Uncertain)
 *   - Confidence bar
 *   - LLM reasoning
 *   - Collapsible evidence sources
 */

import { useState } from 'react';

/** Map verdict string → display config */
const VERDICT_CONFIG = {
  True: {
    label: 'Supported',
    icon: '✓',
    cls: 'verdict-true',
  },
  False: {
    label: 'Disputed',
    icon: '✗',
    cls: 'verdict-false',
  },
  Uncertain: {
    label: 'Uncertain',
    icon: '?',
    cls: 'verdict-uncertain',
  },
};

function ConfidenceBar({ confidence }) {
  const pct = Math.round(confidence * 100);
  const cls =
    pct >= 75 ? 'conf-high' :
    pct >= 50 ? 'conf-mid' :
    'conf-low';

  return (
    <div className="confidence-bar-wrapper">
      <span className="confidence-label">Confidence</span>
      <div className="confidence-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`confidence-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="confidence-pct">{pct}%</span>
    </div>
  );
}

function formatTimestamp(seconds) {
  if (seconds === undefined || seconds === null || isNaN(seconds)) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const paddedSecs = String(secs).padStart(2, '0');
  if (hrs > 0) {
    const paddedMins = String(mins).padStart(2, '0');
    return `${hrs}:${paddedMins}:${paddedSecs}`;
  }
  return `${mins}:${paddedSecs}`;
}

function ClaimCard({ index, claim, verdict, confidence, reasoning, evidence, timestamp, videoId }) {
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const config = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.Uncertain;

  return (
    <article className={`claim-card ${config.cls}`}>
      {/* ── Card Header ─────────────────────────────────── */}
      <div className="claim-header">
        <div className="claim-index-group">
          <div className="claim-index">#{index}</div>
          {timestamp !== undefined && timestamp !== null && (
            <a
              href={`https://www.youtube.com/watch?v=${videoId}&t=${timestamp}s`}
              target="_blank"
              rel="noopener noreferrer"
              className="timestamp-link"
              title="Jump to this claim in the video"
            >
              <span className="timestamp-icon">▶</span>
              <span>{formatTimestamp(timestamp)}</span>
            </a>
          )}
        </div>
        <div className={`verdict-badge ${config.cls}`}>
          <span className="verdict-icon" aria-hidden="true">{config.icon}</span>
          <span>{config.label}</span>
        </div>
      </div>

      {/* ── Claim Text ──────────────────────────────────── */}
      <blockquote className="claim-text">
        "{claim}"
      </blockquote>

      {/* ── Confidence Bar ──────────────────────────────── */}
      <ConfidenceBar confidence={confidence} />

      {/* ── LLM Reasoning ───────────────────────────────── */}
      <div className="reasoning-block">
        <p className="reasoning-label">AI Reasoning</p>
        <p className="reasoning-text">{reasoning}</p>
      </div>

      {/* ── Evidence Toggle ─────────────────────────────── */}
      {evidence && evidence.length > 0 && (
        <div className="evidence-section">
          <button
            className="evidence-toggle"
            onClick={() => setEvidenceOpen(o => !o)}
            aria-expanded={evidenceOpen}
          >
            <span>{evidenceOpen ? '▾' : '▸'}</span>
            Web Evidence ({evidence.length} source{evidence.length !== 1 ? 's' : ''})
          </button>

          {evidenceOpen && (
            <ul className="evidence-list">
              {evidence.map((e, i) => (
                <li key={i} className="evidence-item">
                  <p className="evidence-title">
                    {e.url ? (
                      <a href={e.url} target="_blank" rel="noopener noreferrer">
                        {e.title}
                      </a>
                    ) : (
                      e.title
                    )}
                  </p>
                  <p className="evidence-snippet">{e.snippet}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export default ClaimCard;
