const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Keeps screenshots/recordings whose upload failed (network down, server 5xx)
// on disk and retries them later, so nothing is lost on a flaky connection.
const MAX_ITEMS = 40;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
let flushing = false;

const dir = () => path.join(app.getPath('userData'), 'pending-uploads');
const rm = (p) => { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } };

function drop(id, ext) {
  rm(path.join(dir(), id + '.json'));
  rm(path.join(dir(), id + ext));
}

function list() {
  try { return fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { return []; }
}

function enqueue(kind, filePath, meta) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(filePath);
    fs.copyFileSync(filePath, path.join(dir(), id + ext));
    fs.writeFileSync(path.join(dir(), id + '.json'), JSON.stringify({ ...meta, kind, ext, queuedAt: Date.now() }));
    // keep only the newest MAX_ITEMS
    list().slice(0, Math.max(0, list().length - MAX_ITEMS)).forEach((f) => {
      const id2 = f.slice(0, -5);
      let ext2 = '';
      try { ext2 = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')).ext || ''; } catch (e) { /* corrupt */ }
      drop(id2, ext2);
    });
  } catch (e) { /* best effort */ }
}

// uploaders: { [kind]: (filePath, meta) => Promise }
async function flush(uploaders) {
  if (flushing) return;
  flushing = true;
  try {
    for (const f of list()) {
      const id = f.slice(0, -5);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')); }
      catch (e) { rm(path.join(dir(), f)); continue; }

      const file = path.join(dir(), id + meta.ext);
      if (!fs.existsSync(file) || Date.now() - meta.queuedAt > MAX_AGE_MS || !uploaders[meta.kind]) {
        drop(id, meta.ext);
        continue;
      }
      try {
        await uploaders[meta.kind](file, meta);
        drop(id, meta.ext);
      } catch (e) {
        const s = e.response && e.response.status;
        if (s && s < 500 && s !== 408 && s !== 429) drop(id, meta.ext); // permanent rejection
        else break; // still offline / server down: try again later
      }
    }
  } finally {
    flushing = false;
  }
}

module.exports = { enqueue, flush };