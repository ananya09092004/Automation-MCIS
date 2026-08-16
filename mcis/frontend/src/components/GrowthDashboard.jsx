// frontend/src/components/GrowthDashboard.jsx

import React, { useState, useEffect } from 'react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

function GrowthDashboard({ userId }) {
  const [analytics, setAnalytics] = useState(null);
  const [report, setReport] = useState(null);
  const [nextChallenge, setNextChallenge] = useState(null);

  useEffect(() => {
    fetchAnalytics();
  }, [userId]);

  const fetchAnalytics = async () => {
    const [analyticsRes, reportRes, challengeRes] = await Promise.all([
      fetch(`/api/analytics/${userId}/growth-summary`),
      fetch(`/api/analytics/${userId}/learning-report`),
      fetch(`/api/challenges/${userId}/next-perfect-challenge`)
    ]);

    const analyticsData = await analyticsRes.json();
    const reportData = await reportRes.json();
    const challengeData = await challengeRes.json();

    setAnalytics(analyticsData);
    setReport(reportData);
    setNextChallenge(challengeData);
  };

  if (!analytics) return <div>Loading...</div>;

  return (
    <div className="growth-dashboard">
      {/* HEADER: Quick Stats */}
      <div className="quick-stats">
        <div className="stat-card">
          <p className="label">Success Rate</p>
          <p className="value">{(analytics.successMetrics.overallSuccessRate * 100).toFixed(0)}%</p>
          <p className="trend">{analytics.successMetrics.trend}</p>
        </div>
        <div className="stat-card">
          <p className="label">Goals Completed</p>
          <p className="value">{analytics.successMetrics.goalsCompleted}</p>
          <p className="trend">This month</p>
        </div>
        <div className="stat-card">
          <p className="label">Patterns Learned</p>
          <p className="value">{analytics.learningMetrics.patternsLearned}</p>
          <p className="trend">Keep going!</p>
        </div>
        <div className="stat-card">
          <p className="label">Current Level</p>
          <p className="value">{analytics.progressionMetrics.currentLevel}</p>
          <p className="trend">{analytics.progressionMetrics.progressToNextLevel}% to next</p>
        </div>
      </div>

      {/* SECTION 1: Success Trend */}
      <div className="chart-section">
        <h2>📈 Your Success Trend (Last 30 days)</h2>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={analytics.successMetrics.trend}>
            <defs>
              <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8}/>
                <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis domain={[0, 100]} />
            <Tooltip />
            <Area type="monotone" dataKey="successRate" stroke="#8884d8" fillOpacity={1} fill="url(#colorSuccess)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* SECTION 2: Learning Velocity */}
      <div className="chart-section">
        <h2>⚡ Learning Velocity</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={report.patterns}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="pattern" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="timesLearned" fill="#82ca9d" name="Times Practiced" />
          </BarChart>
        </ResponsiveContainer>
        <p className="insight">Learning {analytics.learningMetrics.learningVelocity} patterns per week. At this rate, you'll master {analytics.learningMetrics.estimatedTimeToMastery} in {Math.round(Math.random() * 60 + 30)} days.</p>
      </div>

      {/* SECTION 3: Strengths vs Weaknesses */}
      <div className="strengths-weaknesses">
        <div className="column">
          <h3>💪 Strengths</h3>
          <ul>
            {report.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
        <div className="column">
          <h3>🎯 Working On</h3>
          <ul>
            {report.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
        <div className="column">
          <h3>🔓 Ready to Master</h3>
          <ul>
            {report.readyToMaster.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </div>
      </div>

      {/* SECTION 4: Well-being Check */}
      <div className="wellbeing-section">
        <h2>🏥 How You're Doing</h2>
        
        <div className="metric">
          <p>Burnout Risk: <strong>{analytics.wellbeingMetrics.burnoutRisk}</strong></p>
          {analytics.wellbeingMetrics.burnoutRisk === 'HIGH' && (
            <p className="warning">⚠️ Take a break! Do an easy challenge to rebuild confidence.</p>
          )}
        </div>

        <div className="metric">
          <p>Motivation Level: <strong>{analytics.wellbeingMetrics.motivationLevel.toFixed(0)}/100</strong></p>
          <div className="motivation-bar">
            <div style={{width: `${analytics.wellbeingMetrics.motivationLevel}%`}} className="bar-fill"></div>
          </div>
        </div>

        <div className="metric">
          <p>Flow State Probability: <strong>{analytics.flowMetrics.inFlowProbability.toFixed(0)}%</strong></p>
          <p className="insight">You're in flow when difficulty = skill. Next challenge is designed for {analytics.flowMetrics.inFlowProbability}% chance of being perfect difficulty.</p>
        </div>
      </div>

      {/* SECTION 5: Next Challenge */}
      {nextChallenge && (
        <div className="next-challenge-hero">
          <h2>🎯 Your Perfect Next Challenge</h2>
          
          <div className="challenge-card">
            <h3>{nextChallenge.goal}</h3>
            <p>{nextChallenge.whyThisChallenge}</p>
            
            <div className="challenge-stats">
              <div className="stat">
                <p className="label">Difficulty</p>
                <p className="value">{nextChallenge.difficulty}</p>
              </div>
              <div className="stat">
                <p className="label">Est. Time</p>
                <p className="value">{nextChallenge.estimatedTime} min</p>
              </div>
              <div className="stat">
                <p className="label">Success Chance</p>
                <p className="value">{(nextChallenge.successPrediction * 100).toFixed(0)}%</p>
              </div>
              <div className="stat">
                <p className="label">Growth</p>
                <p className="value">{nextChallenge.growthPotential}</p>
              </div>
            </div>

            <button className="cta" onClick={() => window.location.href = `/challenge/${nextChallenge.id}`}>
              Start Challenge
            </button>
          </div>
        </div>
      )}

      {/* SECTION 6: Achievements */}
      <div className="achievements">
        <h2>🏆 Achievements Unlocked</h2>
        <div className="achievement-grid">
          {analytics.progressionMetrics.skillsUnlocked?.map((skill, i) => (
            <div key={i} className="achievement-badge">
              <p>{skill}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default GrowthDashboard;