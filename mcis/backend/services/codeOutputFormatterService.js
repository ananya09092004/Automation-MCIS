const logger = require('./logger');

/**
 * Formats code output based on user preference
 * Does NOT force explanation if user doesn't want it
 */
async function formatCodeOutput(pipelineResult, userPreference, codeLanguage) {
  try {
    logger.info(`Formatting output for preference: ${userPreference}`);

    switch (userPreference) {
      
      // ===== PREFERENCE 1: CODE ONLY =====
      case 'code_only':
        return formatCodeOnly(pipelineResult, codeLanguage);

      // ===== PREFERENCE 2: CODE + COMPLEXITY =====
      case 'code_with_complexity':
        return formatCodeWithComplexity(pipelineResult, codeLanguage);

      // ===== PREFERENCE 3: INTERVIEW READY =====
      case 'interview_ready':
        return formatInterviewReady(pipelineResult, codeLanguage);

      // ===== PREFERENCE 4: FULL EXPLANATION =====
      case 'full_explanation':
        return formatFullExplanation(pipelineResult, codeLanguage);

      // ===== PREFERENCE 5: FIX ONLY =====
      case 'fix_only':
        return formatFixOnly(pipelineResult, codeLanguage);

      // ===== DEFAULT: BALANCED =====
      default:
        return formatBalanced(pipelineResult, codeLanguage);
    }
  } catch (err) {
    logger.error(`Format output error: ${err.message}`);
    return {
      output: pipelineResult.code,
      formatted: true
    };
  }
}

// ===== FORMAT 1: CODE ONLY =====
function formatCodeOnly(pipeline, language) {
  // SIRF CODE, KUCH NAHI
  const output = `\`\`\`${language}
${pipeline.code}
\`\`\``;

  return {
    output,
    brief: true,
    has_explanation: false,
    has_complexity: false,
    has_tests_info: false,
    message: `✅ Code ready (${pipeline.tests_passed}/${pipeline.tests_total} tests passed)`
  };
}

// ===== FORMAT 2: CODE + COMPLEXITY =====
function formatCodeWithComplexity(pipeline, language) {
  // CODE + SIRF COMPLEXITY
  let output = `\`\`\`${language}
${pipeline.code}
\`\`\``;

  if (pipeline.complexity) {
    output += `\n\n## Complexity Analysis\n`;
    output += `- **Time:** ${pipeline.complexity.time}\n`;
    output += `- **Space:** ${pipeline.complexity.space}\n`;
    output += `- **Optimal:** ${pipeline.complexity.is_optimal ? 'Yes ✅' : 'No'}\n`;
  }

  return {
    output,
    brief: false,
    has_explanation: false,
    has_complexity: true,
    has_tests_info: false,
    message: `✅ Code + Complexity`
  };
}

// ===== FORMAT 3: INTERVIEW READY =====
function formatInterviewReady(pipeline, language) {
  // CODE + INTERVIEW ANSWER
  let output = `\`\`\`${language}
${pipeline.code}
\`\`\``;

  if (pipeline.interview_explanation) {
    output += `\n\n## How to Explain in Interview\n`;
    output += pipeline.interview_explanation.interview_answer || 
              pipeline.interview_explanation.walkthrough || '';
  }

  if (pipeline.complexity) {
    output += `\n\n## Complexity\n`;
    output += `- Time: ${pipeline.complexity.time}\n`;
    output += `- Space: ${pipeline.complexity.space}\n`;
  }

  return {
    output,
    brief: false,
    has_explanation: true,
    has_complexity: true,
    has_tests_info: true,
    message: `✅ Interview Ready`
  };
}

// ===== FORMAT 4: FULL EXPLANATION =====
function formatFullExplanation(pipeline, language) {
  // SAARAB CHIZ - PURA EXPLANATION
  let output = `\`\`\`${language}
${pipeline.code}
\`\`\``;

  // Code explanation
  if (pipeline.interview_explanation?.walkthrough) {
    output += `\n\n## What This Code Does\n${pipeline.interview_explanation.walkthrough}`;
  }

  // Complexity breakdown
  if (pipeline.complexity) {
    output += `\n\n## Complexity Analysis\n`;
    output += `### Time Complexity: ${pipeline.complexity.time}\n`;
    output += pipeline.interview_explanation?.time_breakdown || '';
    
    output += `\n### Space Complexity: ${pipeline.complexity.space}\n`;
    output += pipeline.interview_explanation?.space_breakdown || '';
  }

  // Optimality proof
  if (pipeline.complexity?.is_optimal && pipeline.interview_explanation?.optimality_proof) {
    output += `\n## Why This is Optimal\n${pipeline.interview_explanation.optimality_proof}`;
  }

  // Test info
  output += `\n\n## Testing\n`;
  output += `- Tests: ${pipeline.tests_passed}/${pipeline.tests_total} passed\n`;
  output += `- Repairs: ${pipeline.repairs_made} applied\n`;
  output += `- Status: ${pipeline.ready_for_interview ? '✅ Interview Ready' : '⚠️ Needs Work'}\n`;

  return {
    output,
    brief: false,
    has_explanation: true,
    has_complexity: true,
    has_tests_info: true,
    message: `✅ Full Explanation`
  };
}

// ===== FORMAT 5: FIX ONLY =====
function formatFixOnly(pipeline, language) {
  // SIRF REPAIRED CODE, KOI EXPLANATION NHI
  if (pipeline.repairs_made > 0) {
    const output = `\`\`\`${language}
${pipeline.code}
\`\`\`\n\n✅ Fixed! ${pipeline.repairs_made} issue(s) corrected.`;
    
    return {
      output,
      brief: true,
      has_explanation: false,
      has_complexity: false,
      has_tests_info: false,
      message: `✅ Code repaired`
    };
  } else {
    return {
      output: `✅ Code is already correct! No repairs needed.`,
      brief: true,
      has_explanation: false,
      has_complexity: false,
      has_tests_info: false,
      message: `✅ No repairs needed`
    };
  }
}

// ===== FORMAT 6: BALANCED (DEFAULT) =====
function formatBalanced(pipeline, language) {
  // CODE + BASIC INFO + OPTION TO EXPAND
  let output = `\`\`\`${language}
${pipeline.code}
\`\`\``;

  output += `\n\n## Quick Summary\n`;
  output += `- **Tests:** ${pipeline.tests_passed}/${pipeline.tests_total} passed ✅\n`;
  output += `- **Repairs:** ${pipeline.repairs_made} applied\n`;
  
  if (pipeline.complexity) {
    output += `- **Complexity:** ${pipeline.complexity.time} time, ${pipeline.complexity.space} space\n`;
  }

  output += `\n*Ask for more details: "Explain this", "Interview prep", "Complexity analysis"*`;

  return {
    output,
    brief: false,
    has_explanation: false,
    has_complexity: false,
    has_tests_info: true,
    message: `✅ Code ready (ask for more details if needed)`,
    expandable: true
  };
}

module.exports = {
  formatCodeOutput
};