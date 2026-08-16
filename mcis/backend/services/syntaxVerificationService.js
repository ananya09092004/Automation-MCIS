const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Groq = require('groq-sdk');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Verify syntax is correct
async function verifySyntax(code, language = 'python') {
  try {
    // Method 1: Actual compilation/syntax check
    const syntaxError = checkSyntax(code, language);
    
    if (syntaxError) {
      // Method 2: Use AI to fix
      return await fixSyntaxError(code, syntaxError, language);
    }

    return { success: true, valid: true, code, errors: [] };
  } catch (err) {
    logger.error(`Verify syntax error: ${err.message}`);
    return { success: false };
  }
}

// Check syntax using language parser
function checkSyntax(code, language) {
  try {
    const tempFile = path.join('/tmp', `syntax_check_${Date.now()}.${getExt(language)}`);
    fs.writeFileSync(tempFile, code);

    const commands = {
      python: `python3 -m py_compile ${tempFile}`,
      javascript: `node --check ${tempFile}`,
      java: `javac ${tempFile}`,
      cpp: `g++ -fsyntax-only ${tempFile}`
    };

    const cmd = commands[language];
    if (!cmd) return null;

    try {
      execSync(cmd, { stdio: 'pipe' });
      fs.unlinkSync(tempFile);
      return null; // No errors
    } catch (err) {
      fs.unlinkSync(tempFile);
      return err.message; // Syntax error found
    }
  } catch (err) {
    return null;
  }
}

// Use AI to fix syntax errors
async function fixSyntaxError(code, error, language) {
  try {
    const prompt = `Fix syntax error in ${language}:

Code:
\`\`\`${language}
${code}
\`\`\`

Error: ${error}

Fix ONLY the syntax error. Return corrected code only.
Must be syntactically perfect.`;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.3 // Low temp for accuracy
    });

    const fixedCode = completion.choices[0].message.content
      .replace(/```python|```javascript|```java|```cpp|```/g, '')
      .trim();

    // Verify fix
    const verified = checkSyntax(fixedCode, language);
    
    if (!verified) {
      return {
        success: true,
        valid: true,
        code: fixedCode,
        fixed: true,
        original_error: error,
        message: 'Syntax error fixed automatically'
      };
    } else {
      return {
        success: true,
        valid: false,
        code: fixedCode,
        error: verified,
        message: 'Could not fully fix syntax error'
      };
    }
  } catch (err) {
    logger.error(`Fix syntax error: ${err.message}`);
    return { success: false };
  }
}

function getExt(language) {
  const map = {
    python: 'py',
    javascript: 'js',
    java: 'java',
    cpp: 'cpp'
  };
  return map[language] || 'py';
}

module.exports = {
  verifySyntax,
  checkSyntax,
  fixSyntaxError
};