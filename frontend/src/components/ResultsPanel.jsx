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
import { jsPDF } from 'jspdf';

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

function ResultsPanel({ result, onReset }) {
  const { videoId, claims, results, overallScore, summary, analyzedAt, url } = result;
  const { label, cls } = scoreLabel(overallScore);

  const trueCount = results.filter(r => r.verdict === 'True').length;
  const falseCount = results.filter(r => r.verdict === 'False').length;
  const uncertainCount = results.filter(r => r.verdict === 'Uncertain').length;

  // Format the analysis timestamp
  const formattedDate = new Date(analyzedAt).toLocaleString();

  const handleExportPDF = () => {
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const primaryColor = [10, 10, 15]; // #0a0a0f
    const secondaryColor = [91, 127, 255]; // #5b7fff
    const mutedColor = [136, 136, 168]; // #txt-secondary
    const lightGray = [244, 244, 248]; // print-friendly light background

    // PDF Header Bar
    doc.setFillColor(...primaryColor);
    doc.rect(0, 0, 210, 25, 'F');
    
    doc.setTextColor(255, 255, 255);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('VERITUBE', 15, 16);
    
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('YOUTUBE CONTENT VERIFICATION REPORT', 52, 15.5);

    // AI Credibility Badge
    doc.setFillColor(...secondaryColor);
    doc.roundedRect(165, 8, 30, 8, 1, 1, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('Helvetica', 'bold');
    doc.text('AI-POWERED', 170, 13.5);

    // Report Metadata Table
    doc.setTextColor(...primaryColor);
    doc.setFontSize(10);
    doc.setFont('Helvetica', 'bold');
    doc.text('REPORT METADATA', 15, 38);
    
    doc.setDrawColor(220, 220, 225);
    doc.setLineWidth(0.3);
    doc.line(15, 40, 195, 40);

    doc.setFont('Helvetica', 'normal');
    doc.setTextColor(...mutedColor);
    doc.text('Video URL:', 15, 47);
    doc.text('Video ID:', 15, 53);
    doc.text('Date Analyzed:', 15, 59);

    doc.setTextColor(...primaryColor);
    // Wrap long video URLs
    const urlText = url || `https://www.youtube.com/watch?v=${videoId}`;
    const urlLines = doc.splitTextToSize(urlText, 140);
    doc.text(urlLines, 45, 47);
    doc.text(videoId || 'N/A', 45, 53);
    doc.text(formattedDate, 45, 59);

    // Credibility Score Box
    doc.setFillColor(...lightGray);
    doc.roundedRect(15, 66, 180, 24, 2, 2, 'F');

    // Score digits
    doc.setTextColor(...primaryColor);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(28);
    doc.text(`${overallScore}`, 22, 83);
    
    doc.setFontSize(12);
    doc.setTextColor(...mutedColor);
    doc.text('/100', 22 + doc.getTextWidth(`${overallScore}`), 80);

    // Verdict Class Badge
    let labelColor = [61, 214, 140]; // green
    if (overallScore < 30) labelColor = [255, 87, 87]; // red
    else if (overallScore < 50) labelColor = [255, 87, 87]; // red
    else if (overallScore < 75) labelColor = [245, 200, 66]; // yellow

    doc.setFillColor(...labelColor);
    doc.roundedRect(55, 74, doc.getTextWidth(label) + 8, 8, 1, 1, 'F');
    doc.setTextColor(...primaryColor);
    doc.setFontSize(9);
    doc.setFont('Helvetica', 'bold');
    doc.text(label.toUpperCase(), 59, 79.5);

    // Breakdowns
    doc.setTextColor(...primaryColor);
    doc.setFontSize(8.5);
    doc.setFont('Helvetica', 'normal');
    doc.text(`SUPPORTED CLAIMS:  ${trueCount}`, 125, 75);
    doc.text(`UNCERTAIN CLAIMS:  ${uncertainCount}`, 125, 80);
    doc.text(`DISPUTED CLAIMS:    ${falseCount}`, 125, 85);

    // Summary Card
    doc.setTextColor(...primaryColor);
    doc.setFontSize(10);
    doc.setFont('Helvetica', 'bold');
    doc.text('ANALYSIS SUMMARY', 15, 100);
    doc.line(15, 102, 195, 102);

    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 30, 40);
    const summaryLines = doc.splitTextToSize(summary || '', 180);
    doc.text(summaryLines, 15, 109);
    
    let currentY = 109 + (summaryLines.length * 5) + 6;

    // Claims Breakdown Section
    doc.setTextColor(...primaryColor);
    doc.setFontSize(10);
    doc.setFont('Helvetica', 'bold');
    doc.text('CLAIM-BY-CLAIM VERIFICATION DETAILS', 15, currentY);
    doc.line(15, currentY + 2, 195, currentY + 2);
    
    currentY += 9;

    results.forEach((claimResult, i) => {
      // Manage page overflow
      if (currentY > 245) {
        doc.addPage();
        currentY = 20;
      }

      const claimText = claims[i] || claimResult.claim;
      const claimVerdict = claimResult.verdict;
      const claimConfidence = Math.round(claimResult.confidence * 100);
      const claimReasoning = claimResult.reasoning;
      const claimTimestamp = formatTimestamp(claimResult.timestamp);

      // Card boundary line
      doc.setDrawColor(230, 230, 235);
      doc.line(15, currentY - 4, 195, currentY - 4);

      // Claim # Header & Timestamp
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(...primaryColor);
      doc.text(`Claim #${i + 1}  [${claimTimestamp}]`, 15, currentY);
      
      // Verdict Badge
      let verdictTag = 'SUPPORTED';
      let verdictTagColor = [61, 214, 140]; // green
      if (claimVerdict === 'False') {
        verdictTag = 'DISPUTED';
        verdictTagColor = [255, 87, 87]; // red
      } else if (claimVerdict === 'Uncertain') {
        verdictTag = 'UNCERTAIN';
        verdictTagColor = [245, 200, 66]; // yellow
      }

      doc.setFillColor(...verdictTagColor);
      doc.roundedRect(165, currentY - 3.5, 30, 5, 0.5, 0.5, 'F');
      doc.setTextColor(...primaryColor);
      doc.setFontSize(7.5);
      doc.text(verdictTag, 180 - (doc.getTextWidth(verdictTag) / 2), currentY - 0.2);

      currentY += 5;

      // Claim Quote Block
      doc.setFont('Helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(50, 50, 60);
      const claimLines = doc.splitTextToSize(`"${claimText}"`, 175);
      doc.text(claimLines, 15, currentY);
      currentY += (claimLines.length * 4.5) + 1;

      // Confidence & Verdict Rating
      doc.setFont('Helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...primaryColor);
      doc.text(`Confidence Score: ${claimConfidence}%`, 15, currentY);
      
      currentY += 4.5;

      // Reasoning Block
      doc.setFont('Helvetica', 'normal');
      doc.setTextColor(80, 80, 100);
      const reasoningLines = doc.splitTextToSize(`AI Verdict Reasoning: ${claimReasoning}`, 175);
      doc.text(reasoningLines, 15, currentY);
      
      currentY += (reasoningLines.length * 4) + 7;
    });

    // Save output
    doc.save(`VeriTube_Report_${videoId || 'analysis'}.pdf`);
  };

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
              claim={claims[i] || claimResult.claim}
              verdict={claimResult.verdict}
              confidence={claimResult.confidence}
              reasoning={claimResult.reasoning}
              evidence={claimResult.evidence}
              timestamp={claimResult.timestamp}
              videoId={videoId}
            />
          ))}
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────────── */}
      <div className="results-actions">
        <button className="reset-btn" onClick={onReset}>
          ← Analyse Another Video
        </button>
        <button className="pdf-btn" onClick={handleExportPDF}>
          ⎙ Export PDF Report
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
