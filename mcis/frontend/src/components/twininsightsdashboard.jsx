import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Brain, Clock } from 'lucide-react';

const TwinInsightsDashboard = ({ userId }) => {
  const [twin, setTwin] = useState(null);
  const [loading, setLoading] = useState(true);
  const API_URL = process.env.REACT_APP_BACKEND_URL || 'https://mcis-backend.onrender.com';

  useEffect(() => {
    fetchTwinData();
  }, [userId]);

  const fetchTwinData = async () => {
    try {
      const res = await fetch(`${API_URL}/api/twin/${userId}`);
      const data = await res.json();
      setTwin(data.twin || data);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="p-8 text-gray-400">Loading Twin...</div>;
  if (!twin) return <div className="p-8 text-gray-500">No data</div>;

  const chartData = [
    { hour: '6 AM', focus: 20, energy: 15 },
    { hour: '9 AM', focus: 95, energy: 90 },
    { hour: '12 PM', focus: 70, energy: 50 },
    { hour: '3 PM', focus: 40, energy: 30 },
    { hour: '6 PM', focus: 60, energy: 65 },
    { hour: '9 PM', focus: 30, energy: 25 },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Brain className="w-8 h-8 text-purple-400" />
          Your Digital Twin
        </h1>
        <p className="text-gray-400 text-sm mt-1">AI model of how you think and work</p>
      </div>

      {/* Traits */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-700 rounded-lg p-4">
          <p className="text-gray-300 text-xs">Learning Pattern</p>
          <p className="text-white text-lg font-bold mt-2">{twin.learning_pattern || 'Visual'}</p>
        </div>
        <div className="bg-gray-700 rounded-lg p-4">
          <p className="text-gray-300 text-xs">Decision Style</p>
          <p className="text-white text-lg font-bold mt-2">{twin.decision_pattern || 'Analytical'}</p>
        </div>
        <div className="bg-gray-700 rounded-lg p-4">
          <p className="text-gray-300 text-xs">Focus Time</p>
          <p className="text-white text-lg font-bold mt-2">{twin.focus_duration || 90} min</p>
        </div>
        <div className="bg-blue-700 rounded-lg p-4">
          <p className="text-blue-200 text-xs">Accuracy</p>
          <p className="text-white text-lg font-bold mt-2">{Math.round((twin.confidence_score || 0.75) * 100)}%</p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-white font-bold flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-cyan-400" />
          Daily Rhythm
        </h2>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#444" />
            <XAxis dataKey="hour" stroke="#999" />
            <YAxis stroke="#999" />
            <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #444' }} />
            <Line type="monotone" dataKey="focus" stroke="#06b6d4" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="energy" stroke="#f59e0b" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        <p className="text-gray-400 text-sm mt-4">Peak: 9-11 AM (Schedule deep work then)</p>
      </div>
    </div>
  );
};

export default TwinInsightsDashboard;