const { desktopCapturer, screen, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require('./logger');

const MAX_WIDTH = 1920;                   // cap size so uploads stay small
const FALLBACK_WIDTHS = [1920, 1280, 800]; // thumbnail attempts, biggest first
const JPEG_QUALITY = 70;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Primary display first, then the rest (display_id can be empty on some machines).
function ordered(sources, primary) {
  const idx = screen.getAllDisplays().findIndex((d) => d.id === primary.id);
  const byId = sources.filter((s) => s.display_id && s.display_id === String(primary.id));
  const byIdx = idx >= 0 && sources[idx] ? [sources[idx]] : [];
  return [...new Set([...byId, ...byIdx, ...sources])];
}

// Strategy 1: desktopCapturer thumbnail. Takes the first NON-EMPTY thumbnail.
async function viaThumbnail(size, primary) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: size, fetchWindowIcons: false
  });
  if (!sources.length) throw new Error('no screen sources');
  const src = ordered(sources, primary).find((s) => s.thumbnail && !s.thumbnail.isEmpty());
  if (!src) throw new Error('all thumbnails empty');
  const jpeg = src.thumbnail.toJPEG(JPEG_QUALITY);
  if (!jpeg || !jpeg.length) throw new Error('JPEG encode failed');
  return jpeg;
}

// Strategy 2: grab one frame from a live screen stream in a hidden window
// (the same mechanism a screen recorder uses, so it works when thumbnails come back empty).
async function viaStream(size, primary) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false
  });
  if (!sources.length) throw new Error('no screen sources');
  const [src] = ordered(sources, primary);

  const win = new BrowserWindow({
    show: false, width: 1, height: 1,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
  });
  try {
    await win.loadURL('about:blank');
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(src.id)},
        maxWidth: ${size.width}, maxHeight: ${size.height} } } });
      try {
        const v = document.createElement('video');
        v.muted = true; v.srcObject = stream;
        await v.play();
        await new Promise((r) => setTimeout(r, 400));
        if (!v.videoWidth) throw new Error('no video frame');
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        return c.toDataURL('image/jpeg', ${JPEG_QUALITY / 100});
      } finally { stream.getTracks().forEach((t) => t.stop()); }
    })()`, true);
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Captures the primary display and returns the saved file path.
// NOTE: On macOS the user must grant "Screen Recording" permission once in
// System Settings > Privacy & Security > Screen Recording.
async function captureScreenshot() {
  const dir = path.join(os.tmpdir(), 'dutybay-agent-shots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const primary = screen.getPrimaryDisplay();
  const sf = primary.scaleFactor || 1;
  const fullW = Math.round(primary.size.width * sf) || MAX_WIDTH;
  const fullH = Math.round(primary.size.height * sf) || 1080;
  const sizeFor = (w) => {
    const width = Math.min(w, fullW);
    return { width, height: Math.round(fullH * (width / fullW)) };
  };

  const errors = [];
  let jpeg = null;

  for (const w of FALLBACK_WIDTHS) {
    try { jpeg = await viaThumbnail(sizeFor(w), primary); break; }
    catch (e) { errors.push(`thumbnail@${w}: ${e.message}`); await sleep(700); }
  }

  if (!jpeg) {
    try { jpeg = await withTimeout(viaStream(sizeFor(MAX_WIDTH), primary), 15000); }
    catch (e) { errors.push(`stream: ${e.message}`); }
  }

  if (!jpeg) throw new Error('All screenshot strategies failed -> ' + errors.join(' | '));
  if (errors.length) log.warn('Screenshot needed a fallback:', errors.join(' | '));

  const filePath = path.join(dir, `shot-${Date.now()}.jpg`);
  fs.writeFileSync(filePath, jpeg);
  return filePath;
}

function cleanup(filePath) {
  fs.unlink(filePath, () => {});
}

module.exports = { captureScreenshot, cleanup };