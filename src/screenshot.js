const screenshot = require('screenshot-desktop');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Captures the primary display silently (no dialogs) and returns the saved file path.
// NOTE: On macOS the user must grant "Screen Recording" permission once in
// System Settings > Privacy & Security > Screen Recording, otherwise this
// will return a black image.
async function captureScreenshot() {
  const dir = path.join(os.tmpdir(), 'dutybay-agent-shots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `shot-${Date.now()}.jpg`;
  const filePath = path.join(dir, filename);

  await screenshot({ filename: filePath, format: 'jpg' });
  return filePath;
}

function cleanup(filePath) {
  fs.unlink(filePath, () => {});
}

module.exports = { captureScreenshot, cleanup };
