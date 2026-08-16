const fs = require('fs');
const path = require('path');

function createFolder(folderPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(folderPath, { recursive: true });
      resolve({ success: true, action: 'createFolder', path: folderPath });
    } catch (err) {
      reject({ success: false, error: err.message });
    }
  });
}

function renameFolder(oldPath, newPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.renameSync(oldPath, newPath);
      resolve({ success: true, action: 'renameFolder', from: oldPath, to: newPath });
    } catch (err) {
      reject({ success: false, error: err.message });
    }
  });
}

function deleteFolder(folderPath) {
  return new Promise((resolve, reject) => {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      resolve({ success: true, action: 'deleteFolder', path: folderPath });
    } catch (err) {
      reject({ success: false, error: err.message });
    }
  });
}

function moveFolder(sourcePath, destPath) {
  return new Promise((resolve, reject) => {
    try {
      const target = path.join(destPath, path.basename(sourcePath));
      fs.renameSync(sourcePath, target);
      resolve({ success: true, action: 'moveFolder', from: sourcePath, to: target });
    } catch (err) {
      reject({ success: false, error: err.message });
    }
  });
}

module.exports = { createFolder, renameFolder, deleteFolder, moveFolder };
