const { exec } = require('child_process');

// NOTE: arbitrary terminal execution is high-risk. This should always be
// routed through security-engine/permissions.js confirmation flow before
// reaching this function — never expose it as an unconfirmed action.

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: cwd || process.env.HOME, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject({ success: false, error: err.message, stderr });
      resolve({ success: true, action: 'runCommand', command, stdout: stdout.trim() });
    });
  });
}

module.exports = { runCommand };
