const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Format code to interview standards
async function beautifyCode(code, language = 'python') {
  try {
    let formatted = code;

    if (language === 'python') {
      formatted = beautifyPython(code);
    } else if (language === 'javascript') {
      formatted = beautifyJavaScript(code);
    } else if (language === 'java') {
      formatted = beautifyJava(code);
    }

    return { success: true, code: formatted };
  } catch (err) {
    logger.error(`Beautify error: ${err.message}`);
    return { success: false, code };
  }
}

function beautifyPython(code) {
  // Add docstring if missing
  if (!code.includes('"""') && !code.includes("'''")) {
    const funcMatch = code.match(/^def\s+(\w+)\s*\((.*?)\):/m);
    if (funcMatch) {
      code = code.replace(
        funcMatch[0],
        `${funcMatch[0]}\n    """\n    Time: O(?) | Space: O(?)\n    """`
      );
    }
  }

  // Format with consistent indentation
  code = code.replace(/^\s+/gm, match => ' '.repeat(Math.floor(match.length / 2) * 2));

  // Add spacing around operators
  code = code.replace(/([a-zA-Z0-9])(=)([a-zA-Z0-9])/g, '$1 $2 $3');

  // Add space after commas
  code = code.replace(/,([^ ])/g, ', $1');

  return code;
}

function beautifyJavaScript(code) {
  // Format with 2-space indentation
  const formatted = code.split('\n').map(line => {
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    return ' '.repeat(Math.floor(indent / 4) * 2) + trimmed;
  }).join('\n');

  return formatted;
}

function beautifyJava(code) {
  // Similar to JavaScript
  return beautifyJavaScript(code);
}

module.exports = {
  beautifyCode
};