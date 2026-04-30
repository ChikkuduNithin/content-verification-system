/**
 * components/LoadingScreen.jsx
 * ─────────────────────────────
 * Animated loading screen shown while the backend pipeline runs.
 * Cycles through pipeline step labels so users know what's happening.
 */

import { useState, useEffect } from 'react';

const STEPS = [
  { icon: '🎬', label: 'Fetching video transcript…' },
  { icon: '🔍', label: 'Extracting key claims…' },
  { icon: '🌐', label: 'Searching web for evidence…' },
  { icon: '🤖', label: 'Running LLM fact-checks…' },
  { icon: '📊', label: 'Aggregating credibility score…' },
];

function LoadingScreen() {
  const [activeStep, setActiveStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState([]);

  useEffect(() => {
    // Advance through steps every ~2.2 seconds
    const interval = setInterval(() => {
      setActiveStep(prev => {
        const next = prev + 1;
        if (next < STEPS.length) {
          setCompletedSteps(c => [...c, prev]);
          return next;
        }
        clearInterval(interval);
        return prev;
      });
    }, 2200);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-inner">
        {/* Pulsing orb */}
        <div className="loading-orb" aria-hidden="true">
          <div className="orb-ring" />
          <div className="orb-ring orb-ring--2" />
          <div className="orb-core">
            <span className="orb-icon">{STEPS[activeStep]?.icon}</span>
          </div>
        </div>

        {/* Current step label */}
        <p className="loading-label">{STEPS[activeStep]?.label}</p>

        {/* Step checklist */}
        <ul className="loading-steps" aria-label="Pipeline progress">
          {STEPS.map((step, i) => {
            const isDone = completedSteps.includes(i);
            const isActive = i === activeStep;
            return (
              <li
                key={i}
                className={`loading-step ${isDone ? 'step-done' : ''} ${isActive ? 'step-active' : ''}`}
              >
                <span className="step-indicator" aria-hidden="true">
                  {isDone ? '✓' : isActive ? '›' : '○'}
                </span>
                <span className="step-text">{step.label}</span>
              </li>
            );
          })}
        </ul>

        <p className="loading-note">This may take 15–30 seconds</p>
      </div>
    </div>
  );
}

export default LoadingScreen;
