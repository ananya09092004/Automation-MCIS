const logger = require('./logger');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Deep complexity analysis - line by line
async function analyzeComplexity(code, algorithm) {
  try {
    const prompt = `Perform DETAILED line-by-line complexity analysis:

Algorithm: ${algorithm}
Code:
\`\`\`
${code}
\`\`\`

Analyze EVERY operation:
1. For each line, identify time complexity
2. Explain why that complexity
3. Identify loops, recursion, nested operations
4. Calculate overall complexity
5. Identify space usage
6. Verify this is OPTIMAL complexity

Format answer as:

LINE-BY-LINE ANALYSIS:
- Line X: [operation] â†’ O(?) because [reason]
- Line Y: [operation] â†’ O(?) because [reason]

LOOP ANALYSIS:
- Outer loop: runs N times
- Inner loop: runs M times
- Combined: O(N*M)

RECURSION ANALYSIS:
- Depth: [how deep]
- Branches: [how many per call]
- Complexity: O(?)

OVERALL COMPLEXITY:
Time: O(?) = [explanation]
Space: O(?) = [explanation]

IS THIS OPTIMAL?
- Can we do better? [yes/no + how]
- Trade-offs? [yes/no + what]

Return as JSON:
{
  "line_by_line": [
    {"line": "for i in range(n):", "complexity": "O(n)", "reason": "..."},
    ...
  ],
  "time_complexity": "O(n log n)",
  "time_reasoning": "...",
  "space_complexity": "O(n)",
  "space_reasoning": "...",
  "is_optimal": true,
  "optimization_possible": "No, this is optimal",
  "proof": "...",
  "interview_explanation": "..."
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.5
    });

    const text = completion.choices[0].message.content;
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, analysis };
  } catch (err) {
    logger.error(`Analyze complexity error: ${err.message}`);
    return { success: false };
  }
}

// Verify complexity claim
async function verifyComplexityClaim(code, claimedComplexity) {
  try {
    const prompt = `Verify if the claimed complexity is correct:

Code:
\`\`\`
${code}
\`\`\`

Claimed complexity: ${claimedComplexity}

Verify:
1. Is this claim correct?
2. If wrong, what's the actual complexity?
3. Explain the mistake if any

Return JSON:
{
  "is_correct": true/false,
  "actual_complexity": "...",
  "explanation": "...",
  "mistake": "if any" or null
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3
    });

    const text = completion.choices[0].message.content;
    const verification = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, verification };
  } catch (err) {
    logger.error(`Verify complexity error: ${err.message}`);
    return { success: false };
  }
}

// Generate interview explanation
async function generateInterviewExplanation(code, complexity, algorithm) {
  try {
    const prompt = `Generate interview-perfect complexity explanation:

Algorithm: ${algorithm}
Code:
\`\`\`
${code}
\`\`\`

Time complexity: ${complexity.time}
Space complexity: ${complexity.space}

Create explanation as if explaining to interviewer:

1. WALKTHROUGH (2-3 sentences)
   "For this algorithm, I'll walk you through what happens..."

2. TIME BREAKDOWN (detailed)
   "The time complexity is O(?) because:
   - First operation: O(?)
   - Loop: O(?)
   - Combined: O(?)"

3. SPACE BREAKDOWN (detailed)
   "The space complexity is O(?) because:
   - Data structure 1: O(?)
   - Recursion stack: O(?)
   - Total: O(?)"

4. PROOF (why this is optimal)
   "This is optimal because:
   - We must visit every element (Î©(n))
   - Cannot do better than..."

5. TRADE-OFFS
   "An alternative approach would be:
   - Approach X: O(?) time, O(?) space
   - Why I chose this: ..."

Return as JSON:
{
  "walkthrough": "...",
  "time_breakdown": "...",
  "space_breakdown": "...",
  "optimality_proof": "...",
  "trade_offs": "...",
  "interview_answer": "Complete answer to give in interview"
}`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.6
    });

    const text = completion.choices[0].message.content;
    const explanation = JSON.parse(text.replace(/```json|```/g, '').trim());

    return { success: true, explanation };
  } catch (err) {
    logger.error(`Generate explanation error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  analyzeComplexity,
  verifyComplexityClaim,
  generateInterviewExplanation
};