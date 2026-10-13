const { exec } = require('child_process');
const os = require('os');

function openApp(appName) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let cmd;

    if (platform === 'win32') {
      cmd = `start "" "${appName}"`;
    } else if (platform === 'darwin') {
      cmd = `open -a "${appName}"`;
    } else {
      cmd = `${appName} &`;
    }

    exec(cmd, (err) => {
      if (err) return reject({ success: false, error: err.message });
      resolve({ success: true, action: 'openApp', app: appName });
    });
  });
}

function closeApp(appName) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let cmd;

    if (platform === 'win32') {
      cmd = `taskkill /IM "${appName}" /F`;
    } else if (platform === 'darwin') {
      cmd = `pkill -f "${appName}"`;
    } else {
      cmd = `pkill -f "${appName}"`;
    }

    exec(cmd, (err) => {
      if (err) return reject({ success: false, error: err.message });
      resolve({ success: true, action: 'closeApp', app: appName });
    });
  });
}

module.exports = { openApp, closeApp };
