const fs = require('fs');
const path = require('path');
const os = require('os');

const TYPE_MAP = {
  Images: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
  Documents: ['.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls', '.ppt', '.pptx'],
  Videos: ['.mp4', '.mov', '.avi', '.mkv'],
  Audio: ['.mp3', '.wav', '.m4a'],
  Archives: ['.zip', '.rar', '.7z', '.tar', '.gz'],
  Installers: ['.exe', '.dmg', '.pkg', '.msi'],
  Code: ['.js', '.py', '.java', '.cpp', '.html', '.css', '.json']
};

function getCategory(ext) {
  for (const [category, extensions] of Object.entries(TYPE_MAP)) {
    if (extensions.includes(ext.toLowerCase())) return category;
  }
  return 'Others';
}

function organizeDownloads(downloadsPath) {
  return new Promise((resolve, reject) => {
    try {
      const dir = downloadsPath || path.join(os.homedir(), 'Downloads');
      const files = fs.readdirSync(dir).filter((f) => {
        const fullPath = path.join(dir, f);
        return fs.statSync(fullPath).isFile();
      });

      const moved = [];

      for (const file of files) {
        const ext = path.extname(file);
        const category = getCategory(ext);
        const categoryFolder = path.join(dir, category);

        if (!fs.existsSync(categoryFolder)) {
          fs.mkdirSync(categoryFolder);
        }

        const sourcePath = path.join(dir, file);
        const destPath = path.join(categoryFolder, file);

        if (!fs.existsSync(destPath)) {
          fs.renameSync(sourcePath, destPath);
          moved.push({ file, category });
        }
      }

      resolve({ success: true, action: 'organizeDownloads', movedCount: moved.length, moved });
    } catch (err) {
      reject({ success: false, error: err.message });
    }
  });
}

module.exports = { organizeDownloads };
