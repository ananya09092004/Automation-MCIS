const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Predict trajectory based on current patterns
async function predictTrajectory(userId, goal, currentProgress) {
  try {
    const prompt = `Based on this goal tracking:

Goal: "${goal}"
Current progress: ${currentProgress}%

Predict the realistic trajectory:
1. What will happen each month?
2. When will they likely complete?
3. What obstacles might appear?
4. What's the success probability?
5. How can they optimize?

Return JSON:
{
  "predicted_completion_months": 6,
  "monthly_progress": [10, 20, 30, 40, 50, 60],
  "obstacles": ["...", "..."],
  "success_probability": 0.8,
  "optimizations": ["...", "..."],
  "confidence": 0.85
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const prediction = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, prediction };
  } catch (err) {
    logger.error(`Predict trajectory error: ${err.message}`);
    return { success: false };
  }
}

// Get completion date prediction
async function predictCompletionDate(goal, currentProgress, userCapacity) {
  try {
    // Simple calculation
    const remaining = 100 - currentProgress;
    const monthsPerPercent = (remaining / userCapacity) / 30; // days to months
    
    const completionDate = new Date();
    completionDate.setMonth(completionDate.getMonth() + Math.ceil(monthsPerPercent));

    return {
      success: true,
      predicted_date: completionDate.toISOString().split('T')[0],
      months_remaining: Math.ceil(monthsPerPercent)
    };
  } catch (err) {
    logger.error(`Predict date error: ${err.message}`);
    return { success: false };
  }
}

// Identify obstacles that might appear
async function identifyPotentialObstacles(userId, goal, context) {
  try {
    const prompt = `Based on this goal and user context:

Goal: "${goal}"
User: ${context}

What are the TOP 5 obstacles that might appear?
What's the probability of each?
How can they be prevented?

Return JSON:
{
  "obstacles": [
    { "name": "...", "probability": 0.6, "prevention": "..." },
    ...
  ]
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, obstacles: result.obstacles };
  } catch (err) {
    logger.error(`Identify obstacles error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  predictTrajectory,
  predictCompletionDate,
  identifyPotentialObstacles
};