// frontend/src/pages/HybridExecutionPage.jsx

import React, { useState, useEffect } from 'react';

function HybridExecutionPage({ userId, goal }) {
  const [status, setStatus] = useState('loading');
  const [steps, setSteps] = useState([]);
  const [teachings, setTeachings] = useState([]);
  const [growth, setGrowth] = useState(null);
  const [nextChallenge, setNextChallenge] = useState(null);

  useEffect(() => {
    const eventSource = new EventSource(
      `/api/hybrid/${userId}/execute-goal`,
      {
        method: 'POST',
        body: JSON.stringify({ goal })
      }
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'step-complete') {
        setSteps(prev => [...prev, data]);
      }

      if (data.type === 'teaching') {
        // SHOW TEACHING MOMENT
        setTeachings(prev => [...prev, data]);
        
        return (
          <div className="teaching-card">
            <h3>💡 Learning Moment</h3>
            <p><strong>What happened:</strong> {data.whatHappened}</p>
            <p><strong>Why:</strong> {data.whyThisApproach}</p>
            <p><strong>Remember:</strong> {data.patternToRemember}</p>
            
            <div className="variant-challenge">
              <h4>Try it yourself:</h4>
              <p>{data.challenge.problem}</p>
              <input 
                type="text" 
                placeholder="Your solution..."
                onSubmit={(solution) => {
                  // Verify solution
                }}
              />
            </div>
          </div>
        );
      }

      if (data.type === 'growth') {
        setGrowth(data);
      }

      if (data.type === 'complete') {
        setStatus('complete');
        setNextChallenge(data.nextChallenge);
      }
    };

    return () => eventSource.close();
  }, [userId, goal]);

  return (
    <div className="hybrid-execution">
      {/* Step Progress */}
      <div className="steps-container">
        {steps.map((step, i) => (
          <div key={i} className="step completed">
            <h4>{step.step}</h4>
            <pre>{step.output}</pre>
          </div>
        ))}
      </div>

      {/* Teaching Moments */}
      <div className="teachings-container">
        {teachings.map((teaching, i) => (
          <div key={i} className="teaching-card">
            <h3>💡 You Learned: {teaching.patternToRemember}</h3>
            <p>{teaching.whyThisApproach}</p>
            
            {/* Mini Challenge */}
            <div className="mini-challenge">
              <p>Try it: {teaching.challenge.problem}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Growth Summary */}
      {growth && (
        <div className="growth-card">
          <h2>📈 You Leveled Up!</h2>
          <p>Skills gained: {growth.skillsGained}</p>
          <p>Level: {growth.levelBefore} → {growth.levelAfter}</p>
        </div>
      )}

      {/* Next Challenge */}
      {nextChallenge && (
        <div className="next-challenge-card">
          <h2>🎯 Next Challenge (Harder!)</h2>
          <p>{nextChallenge.goal}</p>
          <p>Est. time: {nextChallenge.estimatedTime} min</p>
          <button onClick={() => {
            // Start next challenge
          }}>
            Accept Challenge
          </button>
        </div>
      )}
    </div>
  );
}

export default HybridExecutionPage;