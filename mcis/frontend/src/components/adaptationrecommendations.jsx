import React, { useState } from 'react';
import { Lightbulb } from 'lucide-react';

const AdaptationRecommendations = ({ userId }) => {
  const [dismissed, setDismissed] = useState([]);

  // Mock recommendations (from Twin analysis)
  const allRecommendations = [
    {
      id: 1,
      title: 'Slow down your learning pace',
      description: 'You\'re absorbing too much material at once. Reducing pace by 20% will increase success to 95%.',
      impact: 'High',
      icon: '⏱️',
      action: 'Adjust pace'
    },
    {
      id: 2,
      title: 'Block notifications 9-11 AM',
      description: 'Your peak hours are being interrupted. Enable focus mode during your most productive time.',
      impact: 'High',
      icon: '🎯',
      action: 'Set focus mode'
    },
    {
      id: 3,
      title: 'Take a walk at 2 PM',
      description: 'Your energy dips in the afternoon. A short walk will refresh your mind and prevent procrastination.',
      impact: 'Medium',
      icon: '🚶',
      action: 'Schedule break'
    },
  ];

  const recommendations = allRecommendations.filter(r => !dismissed.includes(r.id));

  const handleApply = (id) => {
    // TODO: Send to backend
    console.log('Applied recommendation:', id);
  };

  const handleDismiss = (id) => {
    setDismissed([...dismissed, id]);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Lightbulb className="w-8 h-8 text-amber-400" />
          Smart Recommendations
        </h1>
        <p className="text-gray-400 text-sm mt-1">Based on your Digital Twin's analysis</p>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 ? (
        <div className="space-y-4">
          {recommendations.map((rec) => (
            <div key={rec.id} className="bg-gray-800 rounded-lg p-5 hover:bg-gray-750 transition-colors border-l-4 border-amber-500">
              <div className="flex items-start gap-4">
                {/* Icon */}
                <div className="text-3xl flex-shrink-0">{rec.icon}</div>

                {/* Content */}
                <div className="flex-1">
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <h3 className="text-white font-bold">{rec.title}</h3>
                      <p className="text-gray-400 text-sm mt-2">{rec.description}</p>
                    </div>
                    {/* Impact Badge */}
                    <div className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0 ${
                      rec.impact === 'High' 
                        ? 'bg-red-900 text-red-300' 
                        : 'bg-amber-900 text-amber-300'
                    }`}>
                      {rec.impact} Impact
                    </div>
                  </div>

                  {/* Buttons */}
                  <div className="flex items-center gap-3 mt-4">
                    <button
                      onClick={() => handleApply(rec.id)}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-sm font-semibold transition-colors"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => handleDismiss(rec.id)}
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-semibold transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 bg-gray-800 rounded-lg">
          <p className="text-gray-400">You're all caught up! No new recommendations.</p>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-gray-800 rounded-lg p-4 border-l-4 border-blue-500">
        <p className="text-blue-300 text-sm">
          💡 <strong>Smart Tip:</strong> These recommendations are generated from analyzing your behavior patterns. Apply them to improve your productivity and well-being!
        </p>
      </div>
    </div>
  );
};

export default AdaptationRecommendations;