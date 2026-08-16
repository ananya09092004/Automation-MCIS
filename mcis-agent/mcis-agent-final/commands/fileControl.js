const { exec } = require('child_process');
const os = require('os');
const path = require('path');

function searchFile(fileName, searchDir) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    const dir = searchDir || os.homedir();
    let cmd;

    if (platform === 'win32') {
      cmd = `where /r "${dir}" "${fileName}"`;
    } else {
      cmd = `find "${dir}" -iname "*${fileName}*" -type f`;
    }

    exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject({ success: false, error: 'File not found' });
      const results = stdout.split('\n').filter(Boolean);
      resolve({ success: true, action: 'searchFile', matches: results });
    });
  });
}

function openFile(filePath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let cmd;

    if (platform === 'win32') {
      cmd = `start "" "${filePath}"`;
    } else if (platform === 'darwin') {
      cmd = `open "${filePath}"`;
    } else {
      cmd = `xdg-open "${filePath}"`;
    }

    exec(cmd, (err) => {
      if (err) return reject({ success: false, error: err.message });
      resolve({ success: true, action: 'openFile', file: path.basename(filePath) });
    });
  });
}

module.exports = { searchFile, openFile };
