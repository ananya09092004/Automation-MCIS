const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Simulate a single future path
async function simulateFuture(userId, pathName, decision, userContext, monthsAhead = 24) {
  try {
    const prompt = `You are a future simulator. Simulate this path for ${monthsAhead} months:

Decision: "${decision}"
Path: "${pathName}"
User context: ${JSON.stringify(userContext)}

Generate a realistic simulation with:
1. Monthly milestones (what happens each month)
2. Income trajectory (monthly values)
3. Skill growth (how skills evolve)
4. Happiness score (0-1 each month)
5. Stress level (0-1 each month)
6. Success probability (0-1)
7. Final state (where they end up)
8. Alignment with values (0-1)
9. Risk level (low/medium/high)

Return ONLY valid JSON:
{
  "milestones": [
    { "month": 1, "description": "..." },
    ...
  ],
  "income_trajectory": [2000, 2500, ...],
  "skill_growth": {
    "DSA": [0.5, 0.55, 0.60, ...],
    "Python": [0.7, 0.72, ...],
    ...
  },
  "happiness": [0.6, 0.65, ...],
  "stress": [0.7, 0.65, ...],
  "success_probability": 0.75,
  "final_state": "Senior engineer, $150k, leading team",
  "alignment_with_values": 0.85,
  "risk_level": "medium"
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    });

    const text = completion.choices[0].message.content;
    const simulation = JSON.parse(text.replace(/```json|```/g, '').trim());

    return simulation;
  } catch (err) {
    logger.error(`Simulate future error: ${err.message}`);
    return null;
  }
}

// Create complete decision simulation (multiple paths)
async function createDecisionSimulation(userId, decision, userContext) {
  try {
    // Create simulation record
    const { data: simData, error: simError } = await supabase
      .from('decision_simulations')
      .insert([{
        user_id: userId,
        decision_description: decision,
        paths_simulated: 0,
        created_at: new Date().toISOString()
      }])
      .select();

    if (simError) throw simError;
    const simulationId = simData[0].id;

    // Get potential paths from AI
    const pathsPrompt = `User decision: "${decision}"
    
Generate 3 realistic alternative paths they could take (JSON array with path names):
["Path A: ...", "Path B: ...", "Path C: ..."]

Return ONLY the JSON array.`;

    const pathsCompletion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: pathsPrompt }],
      max_tokens: 200,
      temperature: 0.7
    });

    const pathsText = pathsCompletion.choices[0].message.content;
    const paths = JSON.parse(pathsText.replace(/```json|```/g, '').trim());

    // Simulate each path
    const futures = [];
    for (const path of paths) {
      const simulation = await simulateFuture(userId, path, decision, userContext);
      
      if (simulation) {
        const { error: futureError } = await supabase
          .from('simulated_futures')
          .insert([{
            user_id: userId,
            simulation_id: simulationId,
            path_name: path,
            timeline_months: 24,
            milestones: simulation.milestones,
            income_trajectory: simulation.income_trajectory,
            skill_growth: simulation.skill_growth,
            happiness_score: simulation.happiness,
            stress_level: simulation.stress,
            success_probability: simulation.success_probability,
            final_state: simulation.final_state,
            alignment_with_values: simulation.alignment_with_values,
            risk_level: simulation.risk_level,
            created_at: new Date().toISOString()
          }]);

        if (!futureError) {
          futures.push(simulation);
        }
      }
    }

    // Update simulation count
    await supabase
      .from('decision_simulations')
      .update({ paths_simulated: futures.length })
      .eq('id', simulationId);

    logger.info(`Decision simulation created: ${simulationId}`);
    return { success: true, simulation_id: simulationId, futures };
  } catch (err) {
    logger.error(`Create simulation error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Get simulated futures
async function getSimulatedFutures(simulationId) {
  try {
    const { data, error } = await supabase
      .from('simulated_futures')
      .select('*')
      .eq('simulation_id', simulationId);

    if (error) throw error;
    return { success: true, futures: data || [] };
  } catch (err) {
    logger.error(`Get futures error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  simulateFuture,
  createDecisionSimulation,
  getSimulatedFutures
};