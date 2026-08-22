import React, { useEffect, useState } from 'react';

export default function HistoryPanel({ onSelectHistory, onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('http://localhost:5000/api/history')
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch history');
        return res.json();
      })
      .then(data => {
        setHistory(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="history-modal-overlay" onClick={onClose}>
      <div className="history-modal" onClick={e => e.stopPropagation()}>
        <div className="history-modal-header">
          <h2>Analysis History</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="history-modal-content">
          {loading && <div className="history-message">Loading history...</div>}
          {error && <div className="history-message error">{error}</div>}
          {!loading && !error && history.length === 0 && (
            <div className="history-message">No history found. Try analyzing a video!</div>
          )}
          
          {!loading && !error && history.length > 0 && (
            <div className="history-list">
              {history.map((item, i) => (
                <div key={i} className="history-item" onClick={() => onSelectHistory(item._id)}>
                  <div className="history-item-top">
                    <span className="history-vid">Video: {item.videoId}</span>
                    <span className="history-score">Score: {item.overallScore}/100</span>
                  </div>
                  <div className="history-item-summary">{item.summary}</div>
                  <div className="history-item-date">{new Date(item.analyzedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
