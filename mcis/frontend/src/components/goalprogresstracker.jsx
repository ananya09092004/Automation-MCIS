import React, { useEffect, useState } from 'react';
import { Target } from 'lucide-react';

const GoalProgressTracker = ({ userId }) => {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const API_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    fetchGoals();
  }, [userId]);

  const fetchGoals = async () => {
    try {
      const res = await fetch(`${API_URL}/api/goals/${userId}/all-with-breakdown`);
      const data = await res.json();
      setGoals(data.goals || []);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-gray-400">Loading goals...</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Target className="w-8 h-8 text-emerald-400" />
          My Goals
        </h1>
        <p className="text-gray-400 text-sm mt-1">{goals.length} active goal{goals.length !== 1 ? 's' : ''}</p>
      </div>

      {/* Goals Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goals.map((goal, i) => {
          const progress = goal.current_progress || 0;
          const progressPercent = Math.round(progress * 100);
          
          return (
            <div key={i} className="bg-gray-800 rounded-lg p-5 hover:bg-gray-750 transition-colors">
              {/* Title & Progress % */}
              <div className="flex justify-between items-start mb-3">
                <h3 className="text-white font-bold flex-1">{goal.goal_title || 'Goal'}</h3>
                <p className="text-emerald-400 font-bold text-lg">{progressPercent}%</p>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-2 bg-gray-600 rounded-full overflow-hidden mb-4">
                <div 
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full" 
                  style={{ width: `${progressPercent}%` }}
                ></div>
              </div>

              {/* Phases */}
              {goal.phases && goal.phases.length > 0 && (
                <div className="mb-4 pt-4 border-t border-gray-700">
                  <p className="text-gray-400 text-xs mb-2">PHASES: {Math.round(progressPercent / (100 / goal.phases.length))}/{goal.phases.length}</p>
                  <div className="space-y-1">
                    {goal.phases.slice(0, 2).map((phase, j) => (
                      <p key={j} className="text-gray-300 text-xs">
                        • {typeof phase === 'string' ? phase : (phase.title || phase.name || phase)}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-gray-700">
                <div>
                  <p className="text-gray-400 text-xs">Due Date</p>
                  <p className="text-white text-sm font-semibold mt-1">
                    {goal.target_date 
                      ? new Date(goal.target_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : 'Ongoing'
                    }
                  </p>
                </div>
                <div>
                  <p className="text-gray-400 text-xs">Status</p>
                  <p className="text-emerald-400 text-sm font-semibold mt-1">{goal.status || 'Active'}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty State */}
      {goals.length === 0 && (
        <div className="text-center py-12 bg-gray-800 rounded-lg">
          <Target className="w-12 h-12 text-gray-600 mx-auto mb-3 opacity-50" />
          <p className="text-gray-400">No goals yet. Create one to get started!</p>
        </div>
      )}
    </div>
  );
};

export default GoalProgressTracker;