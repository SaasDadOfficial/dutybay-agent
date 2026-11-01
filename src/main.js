const { app, BrowserWindow, Tray, Menu, powerMonitor, Notification, ipcMain, shell, nativeImage, net, dialog } = require('electron');
const path = require('path');

if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'dutybay-agent-dev'));

const log = require('./logger');
const store = require('./store');
const api = require('./api');
const queue = require('./uploadQueue');
const { captureScreenshot, cleanup } = require('./screenshot');
const { startActivityTracking, stopActivityTracking, emitter: activityEmitter } = require('./activity');
const { captureRecording, cleanup: cleanupRecording, RECORDING_DURATION_MS } = require('./recorder');

process.on('uncaughtException', (e) => log.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e));

// ---- Constants ----
const IDLE_REMINDER_AFTER = 4 * 60;      // seconds
const IDLE_AUTOPAUSE_AFTER = 5 * 60;     // seconds
const IDLE_POLL_INTERVAL_MS = 10 * 1000;
const HEARTBEAT_INTERVAL_MS = 10 * 1000;
const FIRST_SCREENSHOT_AFTER_MS = 5 * 60 * 1000;
const ACTIVITY_REPORT_INTERVAL_MS = 10 * 60 * 1000;
const ROLLOVER_CHECK_INTERVAL_MS = 30 * 1000;
const NETWORK_CHECK_INTERVAL_MS = 5 * 1000;
const OFFLINE_PAUSE_AFTER_FAILS = 3;
const OFFLINE_MSG = 'Internet disconnected. Timer paused. Press Resume when you are back online.';
const OFF_DAY_MSG = 'Today is your off day. Work stopped.';
const KICKED_MSG = 'You were signed out. This account was signed in on another device, or your login expired. Please sign in again.';
const ROLLOVER_TIME = '00:00'; // HH:mm, work day changes at this local time
const [ROLLOVER_HOUR, ROLLOVER_MINUTE] = ROLLOVER_TIME.split(':').map(Number);

// Screenshot/recording windows (ms): defaults until the server value arrives.
const cap = { ssMin: 4 * 60e3, ssMax: 6 * 60e3, recMin: 10 * 60e3, recMax: 15 * 60e3 };

// 32x32 embedded tray icon so the tray never depends on an external file.
const EMBEDDED_TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2UlEQVR4nO1XWw6DMAxjiG92SBCciWk75HaB8YdKH4kdNRIb+A+R2k6aNtA0Z8eNXTBM76/0/vW4U5xwsCZsNaIGscKskdZTHOEoGqghjnBlDdQU1zgTAx7iEndnJXsu/e55nD8mnl2HItnHwjEQI+HJEE8BK47GhNgMaNkzxFpsqEVVwAOQAbaszJrfqMBlwHLJoGuOUwFtbjNV0GLNNyFigt2uJGt0GlqHUVxp8zS0Tr8YyRawX7UMctzZHvAwUeIsNmFNExKXeApqmNA4jv9jwhrxbOL/xAoJ+GDzFPcs9gAAAABJRU5ErkJggg==';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => showMain(false));

// Daily target from the employee profile; the effective target is min(this, today's work limit).
let baseTargetSeconds = 8 * 3600;

// Runtime state (not persisted, rebuilt from server on reconnect)
const state = {
  status: 'idle', // idle | active | paused
  sessionId: null,
  activeSeconds: 0,
  idleSeconds: 0,
  reminderFired: false,
  user: store.get('user'),
  company: store.get('company'),
  dailyTargetSeconds: 8 * 3600,
  maxWorkSeconds: null, // today's work limit: null = no limit, 0 = not allowed to work today
  error: null
};

// Today's limit comes from the server (max_work_hours + CEO weekday/date rules, smallest wins).
function setLimit(secs) {
  state.maxWorkSeconds = secs ?? null;
  state.dailyTargetSeconds = state.maxWorkSeconds === null
    ? baseTargetSeconds
    : Math.min(baseTargetSeconds, state.maxWorkSeconds);
}

// The backend sends capture windows, daily_target_hours and max_work_seconds_today inside "user".
function applyCaptureSettings(u) {
  if (!u) return;
  [['screenshot_min_seconds', 'ssMin'], ['screenshot_max_seconds', 'ssMax'],
   ['recording_min_seconds', 'recMin'], ['recording_max_seconds', 'recMax']]
    .forEach(([k, f]) => { if (u[k]) cap[f] = u[k] * 1000; });
  baseTargetSeconds = (u.daily_target_hours || 8) * 3600;
  setLimit(u.max_work_seconds_today !== undefined
    ? u.max_work_seconds_today
    : (u.max_work_hours > 0 ? u.max_work_hours * 3600 : null)); // fallback for an older server
}
applyCaptureSettings(state.user);

let mainWindow = null, loginWindow = null, tray = null;
let isQuitting = false;
let trayWorking = false;        // true only if a real Tray was created
const T = {};                   // session timers by name (cleared together in stopTimers)
let networkTimer = null;
let pendingActiveDelta = 0, pendingIdleDelta = 0;
let heartbeatInFlight = false;
let wasOnline = true;
let netFailCount = 0;           // consecutive heartbeat failures with no HTTP response
let pausePendingSync = false;   // paused locally, server not told yet
let pausedByOffline = false;
let syncingPause = false;
let rollingOver = false;
let autoFinishing = false;
let authReset = false;          // true while signing out, so a 401 doesn't trigger a second sign-out

// Activity-report bucket (clicks/keystrokes/active time for the current ~10 min)
let activityPeriodStart = null, periodActiveSeconds = 0, pendingClicks = 0, pendingKeystrokes = 0;
activityEmitter.on('click', () => { if (state.status === 'active') pendingClicks += 1; });
activityEmitter.on('keydown', () => { if (state.status === 'active') pendingKeystrokes += 1; });

// ---------------- Helpers ----------------

const alive = (w) => w && !w.isDestroyed();
const rand = (a, b) => a + Math.random() * (b - a);
const notify = (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); };
const targetReached = () => state.activeSeconds >= state.dailyTargetSeconds;
const maxReached = (secs = state.activeSeconds) => state.maxWorkSeconds !== null && secs >= state.maxWorkSeconds;
const isNetworkError = (e) => !!e && !e.response; // 4xx/5xx is NOT a network error

function errMsg(e) {
  if (e && e.response) return `HTTP ${e.response.status} ${JSON.stringify(e.response.data || {}).slice(0, 300)}`;
  return (e && (e.stack || e.message)) || String(e);
}

// Work-day key in LOCAL time, flips at ROLLOVER_HOUR:ROLLOVER_MINUTE.
function todayStr() {
  const d = new Date(Date.now() - (ROLLOVER_HOUR * 60 + ROLLOVER_MINUTE) * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Seconds already worked today in finished sessions (Finish -> Start continues from it).
const getCarry = () => (store.get('carryDate') === todayStr() ? store.get('carrySeconds') || 0 : 0);
const setCarry = (secs, date) => { store.set('carrySeconds', secs); store.set('carryDate', date); };

// Remember me: wipes the saved login so the next launch shows the login screen.
function clearSavedLogin() {
  ['token', 'user', 'company'].forEach((k) => store.set(k, null));
  store.set('remember', false);
}

function broadcastState() {
  if (alive(mainWindow)) mainWindow.webContents.send('agent:state', state);
  updateTrayMenu();
}

// Re-reads today's limit from the server (the CEO may have changed it, or the day rolled over).
async function refreshLimits() {
  try { applyCaptureSettings((await api.me()).user); }
  catch (e) { /* offline: the server still enforces the limit on start */ }
}

// ---------------- Windows ----------------

function makeWindow(width, height, file) {
  const win = new BrowserWindow({
    width, height, resizable: false, show: false,
    icon: path.join(__dirname, 'assets', 'logo.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', file));
  return win;
}

function createLoginWindow() {
  loginWindow = makeWindow(380, 380, 'login.html');
  loginWindow.once('ready-to-show', () => loginWindow.show());
  loginWindow.on('closed', () => { loginWindow = null; if (!mainWindow) app.quit(); });
}

function createMainWindow() {
  mainWindow = makeWindow(400, 600, 'main.html');
  mainWindow.once('ready-to-show', () => { mainWindow.show(); broadcastState(); });

  // The "X" hides to tray and PAUSES the timer. If the tray is dead, close normally.
  // The "-" minimize button keeps native behavior (tracking continues).
  mainWindow.on('close', (e) => {
    if (isQuitting || !trayWorking) return;
    e.preventDefault();
    mainWindow.hide();
    if (state.status === 'active') pauseSession('tray');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('unresponsive', () => log.warn('Main window became unresponsive'));
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('Renderer process gone:', details.reason);
    mainWindow = null;
    if (!isQuitting) createMainWindow();
  });
}

function showMain(create = true) {
  if (alive(mainWindow)) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (create) createMainWindow();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromDataURL(EMBEDDED_TRAY_ICON_DATA_URL));
    tray.setToolTip('DutyBay Agent');
    updateTrayMenu();
    tray.on('click', () => showMain());
    tray.on('destroyed', () => {
      log.warn('Tray was destroyed unexpectedly — window will no longer hide to tray.');
      trayWorking = false;
    });
    trayWorking = true;
  } catch (err) {
    log.error('Tray creation failed, disabling tray-hide behavior:', err);
    tray = null;
    trayWorking = false;
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Status: ${state.status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => showMain() },
    { label: 'Start', click: () => startSession(), enabled: state.status === 'idle' },
    { label: 'Pause', click: () => pauseSession(), enabled: state.status === 'active' },
    { label: 'Resume', click: () => resumeSession(), enabled: state.status === 'paused' },
    { label: 'Finish', click: () => finishSession(), enabled: !!state.sessionId && targetReached() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

// Back to the login screen: stops everything, forgets the login, swaps windows.
function resetToLogin() {
  stopTimers();
  stopActivityTracking();
  stopNetworkWatch();
  pausePendingSync = pausedByOffline = false;
  clearSavedLogin(); // explicit logout / forced sign-out always forgets the login
  Object.assign(state, { user: null, company: null, sessionId: null, status: 'idle', activeSeconds: 0, error: null });

  isQuitting = true;
  if (alive(mainWindow)) mainWindow.close();
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  trayWorking = false;
  isQuitting = false;

  createLoginWindow();
}

// The server revoked our token (someone signed in on another device). The server session
// keeps running and the new device restores it from /me, so no time is lost.
function forceLogout() {
  if (authReset) return;
  authReset = true;
  log.warn('Token rejected (401) - signing out this device');
  resetToLogin();
  notify('DutyBay Agent', KICKED_MSG);
  dialog.showMessageBox({ type: 'info', title: 'DutyBay Agent', message: KICKED_MSG }).catch(() => {});
}
api.setUnauthorizedHandler(forceLogout);

let updateShown = false;
function forceUpdate(info = {}) {
  if (updateShown) return;
  updateShown = true;
  stopTimers();
  stopActivityTracking();
  stopNetworkWatch();
  dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Update required',
    message: info.message || 'A new version is available. Please update the agent.',
    buttons: ['Download update']
  });
  shell.openExternal(info.download_url || 'https://dutybay.com/download');
  isQuitting = true;
  app.quit();
}
api.setUpdateHandler(forceUpdate);

// ---------------- Session control ----------------

async function startSession() {
  await refreshLimits();
  if (!state.user) return; // signed out while refreshing
  if (maxReached(getCarry())) {
    state.error = state.maxWorkSeconds === 0
      ? 'You are not allowed to work today.'
      : 'Work limit for today already reached.';
    return broadcastState();
  }
  try {
    const data = await api.startSession(); // server blocks off days / reached limits (403 + message)
    state.sessionId = data.session.id;
    state.status = 'active';
    state.activeSeconds = getCarry() + (data.session.active_seconds || 0);
    state.error = null;
    store.set('lastSessionId', state.sessionId);
    store.set('lastSessionDate', todayStr());
    startTimers();
    log.info('Session started', state.sessionId);
  } catch (e) {
    log.error('startSession failed:', errMsg(e));
    state.error = e.response?.data?.message || 'Could not start session. Check connection.';
  }
  broadcastState();
}

// Pauses LOCALLY first so the timer stops even when the server is unreachable;
// pausePendingSync keeps retrying until the server is told.
async function pauseSession(reason = 'manual') {
  if (!state.sessionId) return;
  state.status = 'paused';
  pausedByOffline = reason === 'offline';
  state.reminderFired = false;
  broadcastState();

  try {
    await api.pauseSession(state.sessionId);
    pausePendingSync = false;
    state.error = pausedByOffline ? OFFLINE_MSG : null;
    log.info('Session paused, reason:', reason);
  } catch (e) {
    pausePendingSync = true;
    log.error('pauseSession failed (will sync later):', errMsg(e));
    state.error = pausedByOffline ? OFFLINE_MSG : 'Paused locally. Server not reachable, will sync when online.';
  }
  broadcastState();
}

async function resumeSession() {
  if (!state.sessionId) {
    state.error = 'No active session to resume. Try logging out and back in.';
    return broadcastState();
  }
  try {
    if (!net.isOnline()) throw new Error('No internet connection');
    // If the pause never reached the server it still thinks we are active.
    if (pausePendingSync) pausePendingSync = false;
    else await api.resumeSession(state.sessionId);
    state.status = 'active';
    state.error = null;
    pausedByOffline = false;
    netFailCount = 0;
    startTimers();
    log.info('Session resumed');
  } catch (e) {
    log.error('resumeSession failed:', errMsg(e));
    state.error = e.response?.data?.off_day
      ? e.response.data.message
      : 'Could not reach server to resume: ' + (e.response?.data?.message || e.message);
  }
  broadcastState();
}

// force: skip the daily-target check. carry: remember today's total so a restart
// later the same day continues from it (default: yes for a normal finish, no for rollover).
async function finishSession(force = false, carry = !force) {
  if (!state.sessionId || (!force && !targetReached())) return;
  const totalToday = state.activeSeconds;

  try {
    await flushHeartbeat();
    await flushActivityReport();
    await api.finishSession(state.sessionId);
    log.info('Session finished');
  } catch (e) {
    log.error('finishSession failed:', errMsg(e));
  }

  if (carry) setCarry(totalToday, todayStr());

  Object.assign(state, { status: 'idle', sessionId: null, activeSeconds: 0 });
  pausePendingSync = pausedByOffline = false;
  stopTimers();
  broadcastState();
}

// Today's work limit reached: finish the day, keep the total so it can't be restarted.
function autoFinish() {
  if (autoFinishing) return;
  autoFinishing = true;
  notify('DutyBay Agent', 'Your work limit for today has been reached. Work finished automatically.');
  finishSession(true, true).finally(() => { autoFinishing = false; });
}

// Restores an in-progress session from /me (login + auto-login).
function restoreSession(me) {
  applyCaptureSettings(me.user);
  const s = me.active_session;
  if (!s) return;
  state.sessionId = s.id;
  state.status = s.status === 'paused' ? 'paused' : 'active';
  state.activeSeconds = getCarry() + (s.active_seconds || 0);
  store.set('lastSessionId', s.id);
  store.set('lastSessionDate', todayStr());
  if (state.status === 'active') startTimers();
}

// ---------------- Heartbeat & activity ----------------

async function flushHeartbeat() {
  if (!state.sessionId || heartbeatInFlight) return;
  heartbeatInFlight = true;
  const payload = { active_seconds: pendingActiveDelta, idle_seconds: pendingIdleDelta, status: state.status };
  pendingActiveDelta = pendingIdleDelta = 0;
  try {
    const res = await api.heartbeat(state.sessionId, payload);
    netFailCount = 0;
    if (res && res.account_active === false) {
      state.status = 'paused';
      state.error = 'Your account was deactivated. Tracking paused.';
      stopTimers();
      broadcastState();
    } else if (res && res.off_day) {
      // Off day started while a session was running: close it (no carry).
      notify('DutyBay Agent', 'Today is your off day. Your timer has been stopped.');
      await finishSession(true, false);
      state.error = OFF_DAY_MSG;
      broadcastState();
    } else if (res) {
      // The CEO may change today's limit while the employee is working.
      if (res.max_work_seconds !== undefined) setLimit(res.max_work_seconds);
      if (res.limit_reached) autoFinish();
    }
  } catch (e) {
    // Keep the deltas so no time is lost.
    pendingActiveDelta += payload.active_seconds;
    pendingIdleDelta += payload.idle_seconds;
    log.warn('heartbeat failed:', errMsg(e));
    if (isNetworkError(e) && ++netFailCount >= OFFLINE_PAUSE_AFTER_FAILS) handleOffline('heartbeat');
  } finally {
    heartbeatInFlight = false;
  }
}

async function flushActivityReport() {
  if (!state.sessionId || !activityPeriodStart) return;
  const periodEnd = new Date();
  const payload = {
    session_id: state.sessionId,
    period_start: activityPeriodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    active_seconds: periodActiveSeconds,
    total_seconds: Math.round((periodEnd - activityPeriodStart) / 1000),
    clicks: pendingClicks,
    keystrokes: pendingKeystrokes
  };
  resetActivityBucket(periodEnd);
  try {
    await api.reportActivity(payload);
  } catch (e) {
    log.warn('activity report failed:', errMsg(e)); // best effort: drop the counts
  }
}

function resetActivityBucket(start = new Date()) {
  activityPeriodStart = start;
  periodActiveSeconds = pendingClicks = pendingKeystrokes = 0;
}

// ---------------- Idle & UI tick ----------------

// Every 10s: idle reminder / auto-pause only.
function pollIdle() {
  const idleSecs = powerMonitor.getSystemIdleTime();
  if (state.status !== 'active') return;
  if (idleSecs < 2) { state.reminderFired = false; return; }

  pendingIdleDelta += IDLE_POLL_INTERVAL_MS / 1000;

  if (idleSecs >= IDLE_AUTOPAUSE_AFTER) return pauseSession('idle');

  if (idleSecs >= IDLE_REMINDER_AFTER && !state.reminderFired) {
    state.reminderFired = true;
    shell.beep();
    notify('DutyBay Agent', 'You have been idle for a few minutes. Move your mouse to stay active, or you will be auto-paused soon.');
  }
}

// Every 1s: live timer. Deliberately does NOT check idle time (see pollIdle).
function uiTick() {
  if (state.status !== 'active') return;
  state.activeSeconds += 1;
  pendingActiveDelta += 1;
  periodActiveSeconds += 1;
  broadcastState();

  // Auto-finish the moment today's work limit is reached.
  if (maxReached()) autoFinish();
}

// ---------------- Screenshots & recordings ----------------

// Runs `job` on its own randomized [min,max] window while a session is active.
function schedule(name, delay, minKey, maxKey, job) {
  clearTimeout(T[name]);
  T[name] = setTimeout(async () => {
    if (state.status === 'active' && state.sessionId) await job();
    schedule(name, rand(cap[minKey], cap[maxKey]), minKey, maxKey, job);
  }, delay);
}

// How a queued/failed file is uploaded (also used by the retry queue).
const uploaders = {
  screenshot: (f, m) => api.uploadScreenshot(m.sessionId, f, m.capturedAt),
  recording: (f, m) => api.uploadRecording(m.sessionId, f, m.capturedAt, m.duration)
};

// capture and upload are logged separately so we know which step fails.
// A failed upload (offline / 5xx) is kept in the disk queue and retried later.
const captureJob = (label, kind, grab, clean, duration) => async () => {
  let filePath = null;
  try { filePath = await grab(); } catch (e) { log.error(`${label} CAPTURE failed:`, errMsg(e)); }
  if (!filePath) return;
  const meta = { kind, sessionId: state.sessionId, capturedAt: new Date().toISOString(), duration };
  try {
    await uploaders[kind](filePath, meta);
    log.info(`${label} uploaded`);
    queue.flush(uploaders); // connection works, so send anything that was waiting
  } catch (e) {
    log.error(`${label} UPLOAD failed:`, errMsg(e));
    if (!e.response || e.response.status >= 500) queue.enqueue(kind, filePath, meta);
  } finally {
    clean(filePath);
  }
};

const screenshotJob = captureJob('Screenshot', 'screenshot', captureScreenshot, cleanup);
const recordingJob = captureJob('Recording', 'recording', captureRecording, cleanupRecording, RECORDING_DURATION_MS / 1000);

// ---------------- Day rollover ----------------

// When the work-day key differs from the day the session started: close the old
// session, reset to 0, notify, and (if it was running) start the new day's session.
// If the new day is an off day or has a 0h limit, startSession() is refused with a message.
function checkMidnightRollover() {
  const lastDate = store.get('lastSessionDate');
  if (!lastDate || !state.sessionId || rollingOver || lastDate === todayStr()) return;

  rollingOver = true;
  (async () => {
    try {
      const wasActive = state.status === 'active';
      await finishSession(true, false);
      setCarry(0, null); // new day starts from zero
      notify('DutyBay Agent', 'Your timer has been reset. A new work day has started.');
      if (wasActive) await startSession(); // refreshes the new day's limit itself
      else await refreshLimits();
    } catch (e) {
      log.error('Day rollover failed:', errMsg(e));
    } finally {
      rollingOver = false;
    }
  })();
}

// ---------------- Network watchdog ----------------

function handleOffline(source) {
  if (state.status !== 'active') return;
  log.warn('Offline detected via', source, '- pausing timer');
  notify('DutyBay Agent', 'Internet disconnected. Your timer has been paused.');
  pauseSession('offline');
}

// Tells the server about a pause that happened while it was unreachable.
async function syncPendingPause() {
  if (syncingPause || !pausePendingSync) return;
  if (!state.sessionId || state.status !== 'paused') { pausePendingSync = false; return; }
  syncingPause = true;
  try {
    await flushHeartbeat();
    await api.pauseSession(state.sessionId);
    pausePendingSync = false;
    log.info('Pending pause synced to server');
  } catch (e) {
    // still unreachable, retry on the next check
  } finally {
    syncingPause = false;
  }
}

function checkNetwork() {
  if (!net.isOnline()) {
    wasOnline = false;
    return handleOffline('os');
  }
  if (!wasOnline) {
    wasOnline = true;
    netFailCount = 0;
    log.info('Internet is back');
    queue.flush(uploaders); // send screenshots/recordings that failed while offline
    if (pausedByOffline && state.status === 'paused') {
      state.error = 'Internet is back. Press Resume to continue.';
      notify('DutyBay Agent', 'Internet is back. Press Resume to continue tracking.');
      broadcastState();
    }
  }
  if (pausePendingSync) syncPendingPause();
}

function startNetworkWatch() {
  stopNetworkWatch();
  wasOnline = net.isOnline();
  netFailCount = 0;
  networkTimer = setInterval(checkNetwork, NETWORK_CHECK_INTERVAL_MS);
}

function stopNetworkWatch() {
  clearInterval(networkTimer);
  networkTimer = null;
}

// ---------------- Timer lifecycle ----------------

function startTimers() {
  stopTimers();
  T.idle = setInterval(pollIdle, IDLE_POLL_INTERVAL_MS);
  T.ui = setInterval(uiTick, 1000);
  T.heartbeat = setInterval(flushHeartbeat, HEARTBEAT_INTERVAL_MS);
  T.midnight = setInterval(checkMidnightRollover, ROLLOVER_CHECK_INTERVAL_MS);
  schedule('screenshot', FIRST_SCREENSHOT_AFTER_MS, 'ssMin', 'ssMax', screenshotJob);
  schedule('recording', rand(cap.recMin, cap.recMax), 'recMin', 'recMax', recordingJob);
  // Fresh bucket on every (re)start so a paused stretch never folds into the next period.
  resetActivityBucket();
  T.activity = setInterval(flushActivityReport, ACTIVITY_REPORT_INTERVAL_MS);
}

function stopTimers() {
  Object.keys(T).forEach((k) => { clearTimeout(T[k]); delete T[k]; }); // clearTimeout also clears intervals
}

// ---------------- OS power events ----------------

function registerPowerEvents() {
  [['suspend', 'sleep'], ['lock-screen', 'lock'], ['shutdown', 'shutdown']].forEach(([evt, reason]) =>
    powerMonitor.on(evt, () => { if (state.status === 'active') pauseSession(reason); }));
  // Deliberately NOT auto-resuming on 'resume'/'unlock-screen' — user must resume manually.
}

function bootMain() {
  createMainWindow();
  createTray();
  registerPowerEvents();
  startActivityTracking();
  startNetworkWatch();
}

// ---------------- IPC handlers ----------------

ipcMain.handle('agent:login', async (_e, serverUrl, email, password, remember) => {
  try {
    const data = await api.login(serverUrl, email, password, remember);
    authReset = false;
    store.set('remember', !!remember);
    state.user = data.user;
    state.company = data.company;
    state.error = null;
    applyCaptureSettings(data.user);

    if (alive(loginWindow)) loginWindow.close();
    loginWindow = null;
    bootMain();

    try {
      restoreSession(await api.me());
    } catch (e) {
      log.warn('post-login me() failed (non-fatal):', errMsg(e));
    }

    log.info('Login OK, user id:', data.user && data.user.id);
    broadcastState();
    return { ok: true };
  } catch (e) {
    log.error('Login failed:', errMsg(e));
    return { ok: false, message: e.response?.data?.message || 'Login failed.' };
  }
});

ipcMain.handle('agent:logout', async () => {
  if (state.sessionId && state.status === 'active') {
    await flushHeartbeat();
    await flushActivityReport();
    await pauseSession('logout');
  }
  authReset = true; // our own logout revokes the token; ignore any 401 that races with it
  stopTimers();
  await api.logout();
  resetToLogin();
});

ipcMain.handle('agent:getState', () => state);
ipcMain.handle('agent:start', () => startSession());
ipcMain.handle('agent:pause', () => pauseSession('manual'));
ipcMain.handle('agent:resume', () => resumeSession());
ipcMain.handle('agent:finish', () => finishSession());

// ---------------- App lifecycle ----------------

app.whenReady().then(() => {
  setCarry(0, null); // ensure carry is cleared on a fresh install (no lastSessionDate yet)
  log.info('App ready. version:', app.getVersion(), 'electron:', process.versions.electron, 'platform:', process.platform);

  // A saved token only counts if "Remember me" was ticked (also cleans up after a crash).
  if (store.get('token') && !store.get('remember')) clearSavedLogin();

  if (!store.get('token')) return createLoginWindow();

  bootMain();
  api.me()
    .then((me) => {
      state.user = store.get('user');
      state.company = store.get('company');
      restoreSession(me);
      broadcastState();
      queue.flush(uploaders);
    })
    .catch((e) => {
      log.error('Auto-login me() failed:', errMsg(e));
      if (!alive(loginWindow)) createLoginWindow(); // a 401 may already have shown it
    });
});

app.on('before-quit', async (e) => {
  if (isQuitting || !(state.sessionId && state.status === 'active')) return;
  // Best-effort: flush and pause (not finish) so the day isn't lost on a quick reopen.
  e.preventDefault();
  isQuitting = true;
  await flushHeartbeat();
  await flushActivityReport();
  await pauseSession('quit');
  app.quit();
});

// Without "Remember me", forget the login on every real quit.
app.on('will-quit', () => { if (!store.get('remember')) clearSavedLogin(); });

app.on('window-all-closed', () => {
  if (trayWorking && tray && !tray.isDestroyed()) return; // keep running in the tray
  if (process.platform !== 'darwin') app.quit();
});