/**
 * App.jsx
 * ────────
 * Root component. Manages top-level state:
 *   - url           : current URL input value
 *   - loading       : whether the API call is in flight
 *   - error         : any error message to show
 *   - result        : the full analysis result from the backend
 *
 * Renders: UrlInput → (loading indicator | ErrorBanner | ResultsPanel)
 */

import { useState } from 'react';
import UrlInput from './components/UrlInput.jsx';
import ResultsPanel from './components/ResultsPanel.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  /**
   * handleAnalyze
   * Triggered when user submits the form.
   * Calls POST /api/analyze and populates result state.
   */
  async function handleAnalyze(submittedUrl) {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: submittedUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Backend returned a structured error { error: string }
        throw new Error(data.error || `Server error: ${response.status}`);
      }

      setResult(data);
    } catch (err) {
      setError(err.message || 'An unexpected error occurred. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  const handleSelectHistory = (selectedUrl) => {
    setUrl(selectedUrl);
    setShowHistory(false);
    handleAnalyze(selectedUrl);
  };

  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────── */}
      <header className="site-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">▶</span>
            <div className="logo-text">
              <span className="logo-main">VeriTube</span>
              <span className="logo-sub">YouTube Fact Verification System</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <button className="btn-history" onClick={() => setShowHistory(true)}>
              History
            </button>
            <div className="header-badge">AI-Powered</div>
          </div>
        </div>
      </header>

      {/* ── Main Content ─────────────────────────────────── */}
      <main className="main">
        {/* URL Input always visible */}
        <UrlInput
          url={url}
          onChange={setUrl}
          onSubmit={handleAnalyze}
          disabled={loading}
        />

        {/* Pipeline steps indicator */}
        {!loading && !result && !error && (
          <div className="pipeline-info">
            <p className="pipeline-title">How it works</p>
            <ol className="pipeline-steps">
              <li>Transcript extracted from YouTube video</li>
              <li>Key factual claims identified via NLP heuristics</li>
              <li>Web evidence scraped for each claim</li>
              <li>LLM evaluates each claim against evidence</li>
              <li>Overall credibility score computed</li>
            </ol>
          </div>
        )}

        {/* Loading state */}
        {loading && <LoadingScreen />}

        {/* Error banner */}
        {error && !loading && (
          <div className="error-banner" role="alert">
            <span className="error-icon">⚠</span>
            <div>
              <strong>Analysis failed</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        {/* Results panel — shown when analysis is complete */}
        {result && !loading && (
          <ResultsPanel result={result} onReset={() => { setResult(null); setUrl(''); }} />
        )}
      </main>

      {showHistory && (
        <HistoryPanel 
          onClose={() => setShowHistory(false)} 
          onSelectHistory={handleSelectHistory} 
        />
      )}

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="site-footer">
        <p>VeriTube uses AI to assist analysis. Results are not guaranteed accurate. Always consult primary sources.</p>
      </footer>
    </div>
  );
}

export default App;
