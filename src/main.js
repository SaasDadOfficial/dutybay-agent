const { app, BrowserWindow, Tray, Menu, powerMonitor, Notification, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const store = require('./store');
const api = require('./api');
const { captureScreenshot, cleanup } = require('./screenshot');
const { startActivityTracking, stopActivityTracking, emitter: activityEmitter } = require('./activity');
const { captureRecording, cleanup: cleanupRecording, RECORDING_DURATION_MS } = require('./recorder');

// ---- Constants (all in seconds unless *_MS) ----
const IDLE_REMINDER_AFTER = 4 * 60;   // 4 min idle -> reminder sound/notification
const IDLE_AUTOPAUSE_AFTER = 5 * 60;  // 5 min idle -> auto-pause
const IDLE_POLL_INTERVAL_MS = 10 * 1000;
const UI_TICK_INTERVAL_MS = 1000;     // per-second timer display update
const HEARTBEAT_INTERVAL_MS = 1000;   // sent every second so web/app timers stay in sync
const FIRST_SCREENSHOT_AFTER_MS = 5 * 60 * 1000;
const ACTIVITY_REPORT_INTERVAL_MS = 10 * 60 * 1000; // 10-min click/keystroke buckets

// Screenshot/recording windows are now company-configurable. These are just
// fallback defaults used until the server value arrives from /me or /login.
let SCREENSHOT_MIN_MS = 4 * 60 * 1000;
let SCREENSHOT_MAX_MS = 6 * 60 * 1000;
let RECORDING_MIN_MS = 10 * 60 * 1000;
let RECORDING_MAX_MS = 15 * 60 * 1000;

// NOTE: the backend sends screenshot/recording window AND daily_target_hours
// nested inside the "user" object (see AgentAuthController@login / @me),
// not under "company" — pass user here, not company.
function applyCaptureSettings(user) {
  if (!user) return;
  if (user.screenshot_min_seconds) SCREENSHOT_MIN_MS = user.screenshot_min_seconds * 1000;
  if (user.screenshot_max_seconds) SCREENSHOT_MAX_MS = user.screenshot_max_seconds * 1000;
  if (user.recording_min_seconds) RECORDING_MIN_MS = user.recording_min_seconds * 1000;
  if (user.recording_max_seconds) RECORDING_MAX_MS = user.recording_max_seconds * 1000;

  state.dailyTargetSeconds = (user.daily_target_hours || 8) * 3600;
}

let mainWindow = null;
let loginWindow = null;
let tray = null;
let isQuitting = false;
let trayWorking = false; // becomes true only if a real Tray was created successfully

// Embedded 32x32 PNG so the tray NEVER depends on an external icon file being
// present. A missing/empty icon is what was silently killing the tray on
// Windows (clicking it, or minimizing to it, looked like the app "closed"
// because the tray had already died and there was no way back to the window).
const EMBEDDED_TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2UlEQVR4nO1XWw6DMAxjiG92SBCciWk75HaB8YdKH4kdNRIb+A+R2k6aNtA0Z8eNXTBM76/0/vW4U5xwsCZsNaIGscKskdZTHOEoGqghjnBlDdQU1zgTAx7iEndnJXsu/e55nD8mnl2HItnHwjEQI+HJEE8BK47GhNgMaNkzxFpsqEVVwAOQAbaszJrfqMBlwHLJoGuOUwFtbjNV0GLNNyFigt2uJGt0GlqHUVxp8zS0Tr8YyRawX7UMctzZHvAwUeIsNmFNExKXeApqmNA4jv9jwhrxbOL/xAoJ+GDzFPcs9gAAAABJRU5ErkJggg==';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Runtime state (not persisted, rebuilt from server on reconnect)
const state = {
  status: 'idle', // idle | active | paused
  sessionId: null,
  activeSeconds: 0,
  idleSeconds: 0,
  reminderFired: false,
  user: store.get('user'),
  company: store.get('company'),
  dailyTargetSeconds: (store.get('user')?.daily_target_hours || 8) * 3600,
  error: null
};

let idleTimer = null;
let uiTickTimer = null;
let heartbeatTimer = null;
let screenshotTimer = null;
let recordingTimer = null;
let midnightCheckTimer = null;
let activityReportTimer = null;
let pendingActiveDelta = 0; // seconds accumulated since last heartbeat
let pendingIdleDelta = 0;

// Activity-report bucket state (clicks/keystrokes/active time for the
// current ~10-min period, flushed to /api/agent/activity-reports)
let activityPeriodStart = null;
let periodActiveSeconds = 0;
let pendingClicks = 0;
let pendingKeystrokes = 0;

// Raw global input events from uiohook. Only counted while a session is
// actively running — never while paused/idle/logged out, same principle
// as uiTick()/pollIdle() gating on state.status.
activityEmitter.on('click', () => { if (state.status === 'active') pendingClicks += 1; });
activityEmitter.on('keydown', () => { if (state.status === 'active') pendingKeystrokes += 1; });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:state', state);
  }
  updateTrayMenu();
}

// ---------------- Windows ----------------

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 380,
    height: 340,
    resizable: false,
    show: false,
    icon: path.join(__dirname, 'assets', 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  loginWindow.once('ready-to-show', () => {
    loginWindow.show();
  });

  loginWindow.on('closed', () => { loginWindow = null; if (!mainWindow) app.quit(); });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    resizable: false,
    show: false,
    icon: path.join(__dirname, 'assets', 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'main.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    broadcastState();
  });

  // The OS "X" button. Minimizes to tray instead of quitting — tracking
  // must keep running. If the tray failed to create for any reason, fall
  // back to a real quit so the user is never left with a window they can't
  // get back (this was the "app just vanishes" bug).
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    if (trayWorking) {
      e.preventDefault();
      mainWindow.hide();
    }
    // else: let it close normally, no preventDefault
  });

  // The "-" minimize button: intentionally left as native Windows behavior
  // (no preventDefault/hide here) so the app stays visible in the taskbar
  // while minimized. Tracking keeps running in the background either way —
  // only the X button sends it to the tray and off the taskbar.

  mainWindow.on('closed', () => { mainWindow = null; });

  // Self-heal instead of the whole app silently going dead.
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Main window became unresponsive');
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details.reason);
    mainWindow = null;
    if (!isQuitting) {
      createMainWindow();
    }
  });
}

function createTray() {
  try {
    const trayIcon = nativeImage.createFromDataURL(EMBEDDED_TRAY_ICON_DATA_URL);
    tray = new Tray(trayIcon);
    tray.setToolTip('DutyBay Agent');
    updateTrayMenu();

    // Left-click: show/restore the window. Never closes anything.
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createMainWindow();
      }
    });

    tray.on('destroyed', () => {
      console.warn('Tray was destroyed unexpectedly — window will no longer hide to tray.');
      trayWorking = false;
    });

    trayWorking = true;
  } catch (err) {
    // If tray creation fails for any OS-level reason, don't silently break
    // the app — fall back to normal window behavior (X really closes it).
    console.error('Tray creation failed, disabling tray-hide behavior:', err);
    tray = null;
    trayWorking = false;
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: `Status: ${state.status}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Open',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow();
        }
      }
    },
    { label: 'Start', click: () => startSession(), enabled: state.status === 'idle' },
    { label: 'Pause', click: () => pauseSession(), enabled: state.status === 'active' },
    { label: 'Resume', click: () => resumeSession(), enabled: state.status === 'paused' },
    { label: 'Finish', click: () => finishSession(), enabled: !!state.sessionId },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---------------- Session control ----------------

async function startSession() {
  try {
    const data = await api.startSession();
    state.sessionId = data.session.id;
    state.status = 'active';
    state.activeSeconds = data.session.active_seconds || 0;
    state.error = null;
    store.set('lastSessionId', state.sessionId);
    store.set('lastSessionDate', todayStr());
    startTimers();
  } catch (e) {
    state.error = 'Could not start session. Check connection.';
  }
  broadcastState();
}

async function pauseSession(reason = 'manual') {
  if (!state.sessionId) return;
  try {
    await api.pauseSession(state.sessionId);
    state.status = 'paused';
  } catch (e) {
    state.error = 'Could not reach server to pause.';
  }
  stopIdleReminderState();
  broadcastState();
}

async function resumeSession() {
  if (!state.sessionId) {
    state.error = 'No active session to resume. Try logging out and back in.';
    broadcastState();
    return;
  }
  try {
    await api.resumeSession(state.sessionId);
    state.status = 'active';
    state.error = null;
    startTimers();   // restarts uiTick/idle/heartbeat/screenshot/recording/activity loops
  } catch (e) {
    state.error = 'Could not reach server to resume: ' + (e.response?.data?.message || e.message);
  }
  broadcastState();
}

async function finishSession() {
  if (!state.sessionId) return;
  try {
    await flushHeartbeat();
    await flushActivityReport();
    await api.finishSession(state.sessionId);
  } catch (e) {
    // best effort
  }
  state.status = 'idle';
  state.sessionId = null;
  state.activeSeconds = 0;
  stopTimers();
  broadcastState();
}

// ---------------- Heartbeat ----------------

async function flushHeartbeat() {
  if (!state.sessionId) return;
  const payload = {
    active_seconds: pendingActiveDelta,
    idle_seconds: pendingIdleDelta,
    status: state.status
  };
  pendingActiveDelta = 0;
  pendingIdleDelta = 0;
  try {
    const res = await api.heartbeat(state.sessionId, payload);
    if (res && res.account_active === false) {
      // Account deactivated server-side -> force pause and stop.
      state.status = 'paused';
      state.error = 'Your account was deactivated. Tracking paused.';
      stopTimers();
      broadcastState();
    }
  } catch (e) {
    // Keep the deltas so we don't lose time if the request failed.
    pendingActiveDelta += payload.active_seconds;
    pendingIdleDelta += payload.idle_seconds;
  }
}

// ---------------- Activity reports (clicks/keystrokes) ----------------

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

  activityPeriodStart = periodEnd;
  periodActiveSeconds = 0;
  pendingClicks = 0;
  pendingKeystrokes = 0;

  try {
    await api.reportActivity(payload);
  } catch (e) {
    // Best effort — drop this period's counts rather than let them grow
    // unbounded across a long offline stretch.
  }
}

// ---------------- Idle detection ----------------

function stopIdleReminderState() {
  state.reminderFired = false;
}

// Runs every 10s: only responsible for idle/auto-pause/reminder logic.
function pollIdle() {
  const idleSecs = powerMonitor.getSystemIdleTime();

  if (state.status !== 'active') return;

  if (idleSecs < 2) {
    stopIdleReminderState();
    return;
  }

  pendingIdleDelta += (IDLE_POLL_INTERVAL_MS / 1000);

  if (idleSecs >= IDLE_AUTOPAUSE_AFTER) {
    pauseSession('idle');
    return;
  }

  if (idleSecs >= IDLE_REMINDER_AFTER && !state.reminderFired) {
    state.reminderFired = true;
    fireIdleReminder();
  }
}

// Runs every 1s: drives the live timer display in the renderer.
// Deliberately does NOT check powerMonitor here — idle/auto-pause is handled
// separately by pollIdle() every 10s. Gating this on idle time too caused the
// timer to silently freeze whenever getSystemIdleTime() misreported.
function uiTick() {
  if (state.status !== 'active') return;
  state.activeSeconds += 1;
  pendingActiveDelta += 1;
  periodActiveSeconds += 1;
  broadcastState();
}

function fireIdleReminder() {
  shell.beep();
  if (Notification.isSupported()) {
    new Notification({
      title: 'DutyBay Agent',
      body: 'You have been idle for a few minutes. Move your mouse to stay active, or you will be auto-paused soon.'
    }).show();
  }
}

// ---------------- Screenshots ----------------

function scheduleNextScreenshot(delayMs) {
  if (screenshotTimer) clearTimeout(screenshotTimer);
  screenshotTimer = setTimeout(async () => {
    if (state.status === 'active' && state.sessionId) {
      try {
        const filePath = await captureScreenshot();
        await api.uploadScreenshot(state.sessionId, filePath, new Date().toISOString());
        cleanup(filePath);
      } catch (e) {
        // ignore a failed capture/upload, just try again next cycle
      }
    }
    const nextDelay = SCREENSHOT_MIN_MS + Math.random() * (SCREENSHOT_MAX_MS - SCREENSHOT_MIN_MS);
    scheduleNextScreenshot(nextDelay);
  }, delayMs);
}

// ---------------- Recordings ----------------
// Fully independent from the screenshot cycle now — runs on its own
// randomized min/max window (company-configurable).

function scheduleNextRecording(delayMs) {
  if (recordingTimer) clearTimeout(recordingTimer);
  recordingTimer = setTimeout(async () => {
    if (state.status === 'active' && state.sessionId) {
      try {
        const filePath = await captureRecording();
        await api.uploadRecording(
          state.sessionId,
          filePath,
          new Date().toISOString(),
          RECORDING_DURATION_MS / 1000
        );
        cleanupRecording(filePath);
      } catch (e) {
        // ignore a failed capture/upload, next window will try again
      }
    }
    const nextDelay = RECORDING_MIN_MS + Math.random() * (RECORDING_MAX_MS - RECORDING_MIN_MS);
    scheduleNextRecording(nextDelay);
  }, delayMs);
}

// ---------------- Midnight rollover ----------------

function checkMidnightRollover() {
  const lastDate = store.get('lastSessionDate');
  if (!lastDate) return;
  if (lastDate !== todayStr() && state.sessionId) {
    (async () => {
      const wasActive = state.status === 'active';
      await finishSession();
      if (wasActive) {
        await startSession();
      }
    })();
  }
}

// ---------------- Timer lifecycle ----------------

function startTimers() {
  stopTimers();
  idleTimer = setInterval(pollIdle, IDLE_POLL_INTERVAL_MS);
  uiTickTimer = setInterval(uiTick, UI_TICK_INTERVAL_MS);
  heartbeatTimer = setInterval(flushHeartbeat, HEARTBEAT_INTERVAL_MS);
  midnightCheckTimer = setInterval(checkMidnightRollover, 60 * 1000);
  scheduleNextScreenshot(FIRST_SCREENSHOT_AFTER_MS);
  scheduleNextRecording(RECORDING_MIN_MS + Math.random() * (RECORDING_MAX_MS - RECORDING_MIN_MS));

  // Fresh activity-report bucket every time tracking (re)starts, so a
  // paused stretch never gets folded into the next period's counts.
  activityPeriodStart = new Date();
  periodActiveSeconds = 0;
  pendingClicks = 0;
  pendingKeystrokes = 0;
  activityReportTimer = setInterval(flushActivityReport, ACTIVITY_REPORT_INTERVAL_MS);
}

function stopTimers() {
  if (idleTimer) clearInterval(idleTimer);
  if (uiTickTimer) clearInterval(uiTickTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (screenshotTimer) clearTimeout(screenshotTimer);
  if (recordingTimer) clearTimeout(recordingTimer);
  if (midnightCheckTimer) clearInterval(midnightCheckTimer);
  if (activityReportTimer) clearInterval(activityReportTimer);
  idleTimer = uiTickTimer = heartbeatTimer = screenshotTimer = recordingTimer = midnightCheckTimer = activityReportTimer = null;
}

// ---------------- OS power events ----------------

function registerPowerEvents() {
  powerMonitor.on('suspend', () => { if (state.status === 'active') pauseSession('sleep'); });
  powerMonitor.on('lock-screen', () => { if (state.status === 'active') pauseSession('lock'); });
  powerMonitor.on('shutdown', () => { if (state.status === 'active') pauseSession('shutdown'); });
  // Deliberately NOT auto-resuming on 'resume'/'unlock-screen' — user must resume manually.
}

// ---------------- IPC handlers (renderer bridge) ----------------

ipcMain.handle('agent:login', async (_e, serverUrl, email, password) => {
  try {
    const data = await api.login(serverUrl, email, password);
    state.user = data.user;
    state.company = data.company;
    state.error = null;
    applyCaptureSettings(data.user);

    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
    createMainWindow();
    createTray();
    registerPowerEvents();
    startActivityTracking();

    // Reconnect: was there an in-progress session for today?
    try {
      const me = await api.me();
      applyCaptureSettings(me.user);
      if (me.active_session) {
        state.sessionId = me.active_session.id;
        state.status = me.active_session.status === 'paused' ? 'paused' : 'active';
        state.activeSeconds = me.active_session.active_seconds || 0;
        store.set('lastSessionId', state.sessionId);
        store.set('lastSessionDate', todayStr());
        if (state.status === 'active') startTimers();
      }
    } catch (e) { /* non-fatal */ }

    broadcastState();
    return { ok: true };
  } catch (e) {
    const message = e.response && e.response.data && e.response.data.message
      ? e.response.data.message
      : 'Login failed.';
    return { ok: false, message };
  }
});

ipcMain.handle('agent:logout', async () => {
  if (state.sessionId && state.status === 'active') {
    await flushHeartbeat();
    await flushActivityReport();
    await pauseSession('logout');
  }
  stopTimers();
  stopActivityTracking();
  await api.logout();
  state.user = null;
  state.company = null;
  state.sessionId = null;
  state.status = 'idle';
  state.activeSeconds = 0;
  state.error = null;

  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.close(); }
  if (tray && !tray.isDestroyed()) { tray.destroy(); }
  tray = null;
  trayWorking = false;
  isQuitting = false;

  createLoginWindow();
});

ipcMain.handle('agent:getState', () => state);
ipcMain.handle('agent:start', () => startSession());
ipcMain.handle('agent:pause', () => pauseSession('manual'));
ipcMain.handle('agent:resume', () => resumeSession());
ipcMain.handle('agent:finish', () => finishSession());

// ---------------- App lifecycle ----------------

app.whenReady().then(() => {
  const token = store.get('token');
  if (token) {
    createMainWindow();
    createTray();
    registerPowerEvents();
    startActivityTracking();
    api.me()
      .then((me) => {
        state.user = store.get('user');
        state.company = store.get('company');
        applyCaptureSettings(me.user);
        if (me.active_session) {
          state.sessionId = me.active_session.id;
          state.status = me.active_session.status === 'paused' ? 'paused' : 'active';
          state.activeSeconds = me.active_session.active_seconds || 0;
          if (state.status === 'active') startTimers();
        }
        broadcastState();
      })
      .catch(() => { createLoginWindow(); });
  } else {
    createLoginWindow();
  }
});

app.on('before-quit', async (e) => {
  if (isQuitting) return; // already flushed, let it proceed
  if (state.sessionId && state.status === 'active') {
    // Best-effort: flush time and pause (not finish) so the day isn't lost
    // if the user reopens the agent shortly after closing it.
    e.preventDefault();
    isQuitting = true;
    await flushHeartbeat();
    await flushActivityReport();
    await pauseSession('quit');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // If the tray is alive and working, the app must keep running in the
  // background — closing/hiding the window should never kill the process.
  if (trayWorking && tray && !tray.isDestroyed()) return;
  if (process.platform !== 'darwin') app.quit();
});