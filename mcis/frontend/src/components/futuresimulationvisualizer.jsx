import React, { useEffect, useState } from 'react';
import { Target } from 'lucide-react';

const FutureSimulationVisualizer = ({ userId }) => {
  const [simulations, setSimulations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const API_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    fetchSimulations();
  }, [userId]);

  const fetchSimulations = async () => {
    try {
      const res = await fetch(`${API_URL}/api/future/${userId}/simulations?limit=3`);
      const data = await res.json();
      setSimulations(data.simulations || []);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-gray-400">Loading Simulations...</div>;
  if (!simulations || simulations.length === 0) return <div className="p-8 text-gray-500">No simulations</div>;

  const sim = simulations[selected];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Target className="w-8 h-8 text-amber-400" />
          Future Simulations
        </h1>
        <p className="text-gray-400 text-sm mt-1">3 possible paths for your life</p>
      </div>

      {/* Path Selection Buttons */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {simulations.map((s, i) => (
          <button
            key={i}
            onClick={() => setSelected(i)}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              selected === i
                ? 'bg-amber-900 border-amber-500'
                : 'bg-gray-700 border-gray-600 hover:border-amber-400'
            }`}
          >
            <p className="text-white font-bold">{s.path_name || `Path ${i + 1}`}</p>
            <p className="text-amber-300 text-sm mt-1">Success: {Math.round((s.success_probability || 0.7) * 100)}%</p>
            <p className="text-gray-400 text-xs mt-2">{s.timeline_months || 12} months</p>
          </button>
        ))}
      </div>

      {/* Selected Path Details */}
      {sim && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-white font-bold text-lg mb-4">{sim.path_name || 'Selected Path'}</h2>

          {/* Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-gray-300 text-xs">Success Rate</p>
              <p className="text-green-400 text-2xl font-bold mt-2">{Math.round((sim.success_probability || 0.7) * 100)}%</p>
            </div>
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-gray-300 text-xs">Timeline</p>
              <p className="text-blue-400 text-2xl font-bold mt-2">{sim.timeline_months || 12}m</p>
            </div>
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-gray-300 text-xs">Risk Level</p>
              <p className="text-red-400 text-2xl font-bold mt-2">{(sim.risk_level || 'Med').slice(0, 3).toUpperCase()}</p>
            </div>
            <div className="bg-gray-700 rounded-lg p-4">
              <p className="text-gray-300 text-xs">Expected Income</p>
              <p className="text-yellow-400 text-2xl font-bold mt-2">+30%</p>
            </div>
          </div>

          {/* Milestones */}
          {sim.milestones && sim.milestones.length > 0 && (
            <div className="mt-6 pt-6 border-t border-gray-700">
              <h3 className="text-white font-bold mb-4">Key Milestones</h3>
              <div className="space-y-3">
                {sim.milestones.slice(0, 4).map((milestone, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-amber-500 mt-2"></div>
                    <div>
                      <p className="text-white text-sm">{milestone.title || milestone}</p>
                      <p className="text-gray-400 text-xs">{milestone.month ? `Month ${milestone.month}` : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default FutureSimulationVisualizer;