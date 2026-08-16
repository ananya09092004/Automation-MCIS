import { useState, useEffect } from 'react';

function KnowledgeGraphPanel({ userId, darkMode }) {
  const [graph, setGraph] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [loading, setLoading] = useState(false);

  const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    if (!userId) return;
    loadGraph();
  }, [userId]);

  const loadGraph = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${BACKEND_URL}/api/graph/${userId}`);
      const graphData = await res.json();
      setGraph(graphData);

      // Load gaps
      const gapsRes = await fetch(`${BACKEND_URL}/api/graph/${userId}/gaps`);
      const gapsData = await gapsRes.json();
      setGaps(gapsData.gaps || []);
    } catch (err) {
      console.error('Load graph error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      background: darkMode ? '#1a1a2e' : '#f9f9f9',
      border: `1px solid ${darkMode ? '#2a2a4a' : '#e0e0e0'}`,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12
    }}>
      <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
        📊 Knowledge Graph ({graph?.totalNodes || 0} nodes)
      </h4>

      {loading ? (
        <p style={{ color: '#888', fontSize: 13 }}>Loading...</p>
      ) : (
        <>
          {/* Skills */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 8px 0' }}>Skills</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {graph?.nodes?.filter(n => n.node_type === 'skill').map(skill => (
                <span
                  key={skill.id}
                  style={{
                    background: '#6c63ff',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600
                  }}
                >
                  {skill.name}
                </span>
              ))}
            </div>
          </div>

          {/* Projects */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 8px 0' }}>Projects</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {graph?.nodes?.filter(n => n.node_type === 'project').map(project => (
                <span
                  key={project.id}
                  style={{
                    background: '#4ecdc4',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600
                  }}
                >
                  {project.name}
                </span>
              ))}
            </div>
          </div>

          {/* Goals */}
          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 8px 0' }}>Goals</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {graph?.nodes?.filter(n => n.node_type === 'goal').map(goal => (
                <span
                  key={goal.id}
                  style={{
                    background: '#ff6b6b',
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600
                  }}
                >
                  {goal.name}
                </span>
              ))}
            </div>
          </div>

          {/* Knowledge Gaps */}
          {gaps.length > 0 && (
            <div style={{ 
              background: darkMode ? '#2a2a4a' : '#fff5f5',
              border: `1px solid ${darkMode ? '#3a3a5a' : '#ffe0e0'}`,
              borderRadius: 8,
              padding: 10,
              marginTop: 12
            }}>
              <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 8px 0', color: '#ff6b6b' }}>
                Knowledge Gaps
              </p>
              {gaps.map((gap, i) => (
                <p key={i} style={{ fontSize: 11, margin: '4px 0', color: darkMode ? '#e0e0e0' : '#333' }}>
                  💡 {gap.recommendation}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default KnowledgeGraphPanel;