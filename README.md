# DutyBay Desktop Agent

Time-tracking desktop app for DutyBay — connects to the same backend as the website
(see `laravel-backend/` in this bundle for the matching API code).

## Features
- Start / Pause / Resume / Finish work timer
- Full-PC idle detection: 4-min reminder sound, 5-min auto-pause
- Auto-pause on PC sleep, lock, shutdown, account deactivation
- Silent screenshots: first at 5 min, then random 15–25 min
- Heartbeat sync every 30s with the server
- Midnight rollover: auto-finish yesterday, auto-start today
- Runs in system tray; X closes properly (stops tracking), minimize keeps tracking

## Before you run this anywhere

1. `npm install`
2. Add real tray/app icons:
   - `build/tray-icon.png` (used by `src/main.js`, 16x16/32x32 png)
   - `build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icon.png` (Linux) —
     wire these into the `build` block of `package.json` once you have them, otherwise
     electron-builder ships with a default icon.
3. Point the app at your Laravel server (entered by the user in the login screen —
   nothing to hardcode).

## Local development
```bash
npm install
npm start                # run the app from source
npm run build:win        # build Windows installer locally
npm run build:mac        # build macOS .dmg (only works on a Mac)
npm run build:linux      # build Linux AppImage
```

## Auto-build (GitHub Actions)

`.github/workflows/build.yml` is already wired up:

- Every push to `main` builds installers for Windows, macOS, and Linux (uploaded as
  workflow artifacts, not published).
- Pushing a tag like `v1.0.1` builds **and** publishes a public GitHub Release with
  the installers attached, using the built-in `GITHUB_TOKEN` — no extra secrets needed.

### To release a new version
```bash
# bump "version" in package.json, then
git add -A && git commit -m "release v1.0.1"
git tag v1.0.1
git push origin main --tags
```

## Installation notes for end users

### Windows
- Run `DutyBay Agent Setup x.x.x.exe`
- Windows SmartScreen will show "Windows protected your PC" → click **More info → Run anyway**
  (the app is not code-signed)

### macOS
- Open the `.dmg` and drag the app to Applications
- First launch: macOS will say "App is damaged / cannot be opened"
  - Workaround: **right-click the app → Open → Open** (only needed the first time)
  - Or, in Terminal: `xattr -cr "/Applications/DutyBay Agent.app"`
  - (Once the project gets an Apple Developer cert + notarization, this step goes away.)
- **Screen Recording permission is required** for screenshots to work: System Settings →
  Privacy & Security → Screen Recording → enable DutyBay Agent, then relaunch the app.

### Linux
- Make the AppImage executable: `chmod +x DutyBay-Agent-*.AppImage`
- Double-click to run, or: `./DutyBay-Agent-*.AppImage`

## How the state machine works (for future maintenance)

All the logic lives in `src/main.js`:
- `state` holds the in-memory session status (`idle` / `active` / `paused`), the
  current `sessionId`, and accumulated `activeSeconds`.
- `pollIdle()` runs every 10s via `powerMonitor.getSystemIdleTime()`. At 4 minutes
  idle it fires a reminder (beep + notification); at 5 minutes it auto-pauses.
- `flushHeartbeat()` runs every 30s, POSTs accumulated active/idle seconds to
  `/api/agent/sessions/{id}/heartbeat`, and checks the `account_active` flag the
  server returns to detect deactivated accounts.
- `scheduleNextScreenshot()` recursively schedules itself: first capture 5 minutes
  after start, then a new random 15–25 minute delay after each capture.
- `checkMidnightRollover()` runs every minute and compares today's date against the
  date the current session was started on; if it rolled over, it finishes yesterday's
  session and starts a fresh one automatically (only if it was still active).
- Closing the main window (X) calls `app.quit()`, which pauses (not finishes) the
  session via `before-quit` so no time is silently lost, then exits. Minimizing just
  hides the window; the tray icon and all timers keep running.
