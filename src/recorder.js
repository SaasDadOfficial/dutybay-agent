const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RECORDING_DURATION_MS = 20 * 1000;
let recorderWindow = null;

function getRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) return recorderWindow;
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  recorderWindow.loadFile(path.join(__dirname, 'renderer', 'recorder.html'));
  recorderWindow.on('closed', () => { recorderWindow = null; });
  return recorderWindow;
}

// Captures a short, low-res/low-bitrate screen recording of the primary
// display and returns the saved file path. Same OS permission requirement
// as screenshot.js on macOS (Screen Recording, under Privacy & Security).
async function captureRecording() {
  const win = getRecorderWindow();
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  });
  const primary = sources[0];
  if (!primary) throw new Error('No screen source available for recording');

  const dir = path.join(os.tmpdir(), 'dutybay-agent-recordings');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rec-${Date.now()}.webm`);

  const buffer = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Recording timed out')), RECORDING_DURATION_MS + 15000);
    ipcMain.once('recorder:done', (_e, arrayBuffer) => {
      clearTimeout(timeout);
      resolve(Buffer.from(arrayBuffer));
    });
    ipcMain.once('recorder:error', (_e, message) => {
      clearTimeout(timeout);
      reject(new Error(message));
    });
    win.webContents.send('recorder:start', { sourceId: primary.id, durationMs: RECORDING_DURATION_MS });
  });

  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function cleanup(filePath) {
  fs.unlink(filePath, () => {});
}

module.exports = { captureRecording, cleanup, RECORDING_DURATION_MS };