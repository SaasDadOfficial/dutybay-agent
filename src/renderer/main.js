const timerEl = document.getElementById('timer');
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const userLabel = document.getElementById('userLabel');
const errEl = document.getElementById('err');
const progressFill = document.getElementById('progressFill');
const workedTodayEl = document.getElementById('workedToday');
const remainingEl = document.getElementById('remaining');

const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const finishBtn = document.getElementById('finishBtn');

// Falls back to 8h only until the first state update arrives from main
// (which carries dailyTargetSeconds straight from the server's user.daily_target_hours).
let DAILY_TARGET_SECONDS = 8 * 3600;

function formatHMS(totalSeconds) {
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatShort(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function updateButtons(status, activeSeconds) {
  document.body.dataset.status = status || 'idle';

  const targetReached = activeSeconds >= DAILY_TARGET_SECONDS;

  startBtn.style.display = 'none';
  pauseBtn.style.display = 'none';
  resumeBtn.style.display = 'none';
  finishBtn.style.display = 'none';

  if (status === 'active') {
    pauseBtn.style.display = '';
    if (targetReached) finishBtn.style.display = '';
  } else if (status === 'paused') {
    resumeBtn.style.display = '';
    if (targetReached) finishBtn.style.display = '';
  } else {
    // idle
    startBtn.style.display = '';
  }
}

function render(state) {
  console.log('RENDER STATE:', JSON.stringify(state));
  if (!state) return;
  const activeSeconds = state.activeSeconds || 0;
  if (state.dailyTargetSeconds) DAILY_TARGET_SECONDS = state.dailyTargetSeconds;

  timerEl.textContent = formatHMS(activeSeconds);
  userLabel.textContent = state.user ? `${state.user.name} — ${state.company ? state.company.name : ''}` : '—';

  statusPill.className = 'status-pill status-' + (state.status || 'idle');
  statusText.textContent = (state.status || 'idle').replace(/^\w/, c => c.toUpperCase());
  errEl.textContent = state.error || '';

  workedTodayEl.textContent = formatShort(activeSeconds);

  const remainingSeconds = Math.max(0, DAILY_TARGET_SECONDS - activeSeconds);
  remainingEl.textContent = remainingSeconds > 0 ? formatShort(remainingSeconds) : '0m';

  const pct = Math.min(100, (activeSeconds / DAILY_TARGET_SECONDS) * 100);
  progressFill.style.width = pct + '%';

  updateButtons(state.status, activeSeconds);
}

window.agent.onStateUpdate(render);

startBtn.addEventListener('click', () => window.agent.start());
pauseBtn.addEventListener('click', () => window.agent.pause());
resumeBtn.addEventListener('click', () => window.agent.resume());
finishBtn.addEventListener('click', () => window.agent.finish());
document.getElementById('logoutBtn').addEventListener('click', () => window.agent.logout());