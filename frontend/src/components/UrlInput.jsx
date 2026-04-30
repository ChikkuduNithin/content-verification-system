/**
 * components/UrlInput.jsx
 * ────────────────────────
 * URL input form. Validates that the URL looks like a YouTube link
 * before allowing submission.
 */

import { useState } from 'react';

// Basic YouTube URL patterns
const YT_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/(www\.)?youtube\.com\/shorts\//,
];

function isYouTubeUrl(url) {
  return YT_PATTERNS.some(p => p.test(url.trim()));
}

function UrlInput({ url, onChange, onSubmit, disabled }) {
  const [touched, setTouched] = useState(false);

  const isValid = isYouTubeUrl(url);
  const showError = touched && url.length > 0 && !isValid;

  function handleSubmit(e) {
    e.preventDefault();
    setTouched(true);
    if (isValid && !disabled) {
      onSubmit(url.trim());
    }
  }

  // Example URLs for quick testing
  const examples = [
    { label: 'Health video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { label: 'Science talk', url: 'https://www.youtube.com/watch?v=ZSt9tm3RoUU' },
  ];

  return (
    <section className="input-section">
      <h1 className="input-heading">
        Paste a YouTube URL.<br />
        <em>We'll check the facts.</em>
      </h1>

      <form className="url-form" onSubmit={handleSubmit}>
        <div className={`input-wrapper ${showError ? 'has-error' : ''} ${isValid && touched ? 'is-valid' : ''}`}>
          <span className="input-prefix">▶</span>
          <input
            type="url"
            className="url-input"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={e => { onChange(e.target.value); setTouched(true); }}
            onBlur={() => setTouched(true)}
            disabled={disabled}
            aria-label="YouTube video URL"
            aria-invalid={showError}
            spellCheck={false}
          />
          {isValid && <span className="valid-check" aria-hidden="true">✓</span>}
        </div>

        {showError && (
          <p className="field-error" role="alert">
            Please enter a valid YouTube URL (youtube.com/watch?v=... or youtu.be/...)
          </p>
        )}

        <button
          type="submit"
          className="analyze-btn"
          disabled={disabled || !isValid}
        >
          {disabled ? (
            <>
              <span className="btn-spinner" aria-hidden="true" />
              Analysing…
            </>
          ) : (
            <>Verify Content</>
          )}
        </button>
      </form>

      {/* Quick example links */}
      <div className="example-links">
        <span className="example-label">Try:</span>
        {examples.map(ex => (
          <button
            key={ex.url}
            className="example-btn"
            onClick={() => { onChange(ex.url); setTouched(true); }}
            disabled={disabled}
            type="button"
          >
            {ex.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export default UrlInput;
