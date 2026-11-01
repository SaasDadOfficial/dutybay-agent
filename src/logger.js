const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_SIZE = 2 * 1024 * 1024; // 2MB, then rotate once

let logFile = null;

function getLogFile() {
  if (logFile) return logFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'agent.log');
  } catch (e) {
    logFile = null;
  }
  return logFile;
}

function write(level, args) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }
      return String(a);
    })
    .join(' ');

  const line = `[${new Date().toISOString()}] ${level} ${msg}\n`;
  console[level === 'ERROR' ? 'error' : 'log'](line.trim());

  const file = getLogFile();
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_SIZE) {
      fs.renameSync(file, file + '.old');
    }
    fs.appendFileSync(file, line);
  } catch (_) { /* never let logging crash the app */ }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  getLogFile
};