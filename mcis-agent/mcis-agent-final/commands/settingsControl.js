const { exec } = require('child_process');
const os = require('os');

function setVolume(level) {
  // level: 0-100
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let cmd;

    if (platform === 'darwin') {
      cmd = `osascript -e "set volume output volume ${level}"`;
    } else if (platform === 'win32') {
      // Requires nircmd.exe on PATH (free tool, common for Windows volume scripting)
      cmd = `nircmd setsysvolume ${Math.round((level / 100) * 65535)}`;
    } else {
      cmd = `amixer set Master ${level}%`;
    }

    exec(cmd, (err) => {
      if (err) return reject({ success: false, error: err.message });
      resolve({ success: true, action: 'setVolume', level });
    });
  });
}

function installSoftware(packageName) {
  // NOTE: route through permission confirmation before calling this.
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let cmd;

    if (platform === 'darwin') {
      cmd = `brew install ${packageName}`;
    } else if (platform === 'win32') {
      cmd = `winget install ${packageName}`;
    } else {
      cmd = `sudo apt install -y ${packageName}`;
    }

    exec(cmd, { timeout: 120000 }, (err, stdout) => {
      if (err) return reject({ success: false, error: err.message });
      resolve({ success: true, action: 'installSoftware', package: packageName, output: stdout.trim() });
    });
  });
}

module.exports = { setVolume, installSoftware };
