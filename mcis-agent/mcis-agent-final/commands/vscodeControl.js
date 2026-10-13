const { exec } = require('child_process');

function openInVSCode(targetPath) {
  return new Promise((resolve, reject) => {
    exec(`code "${targetPath}"`, (err) => {
      if (err) return reject({ success: false, error: 'VS Code CLI not found. Run "Install code command in PATH" from VS Code command palette.' });
      resolve({ success: true, action: 'openInVSCode', path: targetPath });
    });
  });
}

function runFileInTerminal(filePath, runner) {
  // runner examples: 'node', 'python3'
  return new Promise((resolve, reject) => {
    exec(`${runner} "${filePath}"`, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject({ success: false, error: err.message, stderr });
      resolve({ success: true, action: 'runFileInTerminal', file: filePath, output: stdout.trim() });
    });
  });
}

module.exports = { openInVSCode, runFileInTerminal };
