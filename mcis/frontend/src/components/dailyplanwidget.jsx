import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

const DailyPlanWidget = ({ userId }) => {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(0);
  const API_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    fetchPlan();
  }, [userId]);

  const fetchPlan = async () => {
    try {
      const res = await fetch(`${API_URL}/api/goals/${userId}/today-plan`);
      const data = await res.json();
      setPlan(data.plan || data);
      setCompleted(data.plan?.completed_count || 0);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-gray-400">Loading plan...</div>;

  const tasks = plan?.tasks || [];
  const total = tasks.length || 1;
  const progress = (completed / total) * 100;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white flex items-center gap-2">
          <Clock className="w-6 h-6 text-cyan-400" />
          Today's Focus
        </h2>
        <p className="text-gray-400 text-sm mt-1">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
      </div>

      {/* Progress Bar */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex justify-between items-center mb-2">
          <p className="text-white font-bold">Progress</p>
          <p className="text-cyan-400 font-bold">{completed}/{total}</p>
        </div>
        <div className="w-full h-3 bg-gray-600 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all" 
            style={{ width: `${progress}%` }}
          ></div>
        </div>
        {plan?.focus_area && (
          <p className="text-gray-400 text-xs mt-3">Focus Area: {plan.focus_area}</p>
        )}
      </div>

      {/* Tasks List */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-white font-bold mb-4">Today's Tasks</h3>
        <div className="space-y-3">
          {tasks.slice(0, 6).map((task, i) => {
            const isCompleted = i < completed;
            const taskTitle = typeof task === 'string' ? task : (task.title || task.name || 'Task');
            
            return (
              <div key={i} className="flex items-center gap-3 p-2 hover:bg-gray-700 rounded">
                <div className="w-5 h-5 rounded border-2 border-gray-400 flex items-center justify-center flex-shrink-0">
                  {isCompleted && <div className="w-3 h-3 bg-green-500 rounded-sm"></div>}
                </div>
                <p className={`text-sm flex-1 ${isCompleted ? 'text-gray-500 line-through' : 'text-white'}`}>
                  {taskTitle}
                </p>
                {task.duration && <p className="text-gray-400 text-xs">{task.duration}h</p>}
              </div>
            );
          })}
          {tasks.length === 0 && (
            <p className="text-gray-400 text-sm">No tasks scheduled today</p>
          )}
        </div>
      </div>

      {/* Time Budget */}
      {plan?.estimated_hours && (
        <div className="bg-gray-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs mb-2">ESTIMATED TIME</p>
          <p className="text-white text-3xl font-bold">{plan.estimated_hours}h</p>
          <p className="text-gray-400 text-xs mt-2">Recommended for today</p>
        </div>
      )}
    </div>
  );
};

export default DailyPlanWidget;