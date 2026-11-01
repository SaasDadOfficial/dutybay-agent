const axios = require('axios');
const fs = require('fs');
const store = require('./store');
const { app } = require('electron');
let updateHandler = null;

const DEFAULT_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 60000;

// Called when the server rejects our token (401): logged in on another device,
// token expired or revoked. main.js uses it to sign this device out.
let unauthorizedHandler = null;

function client(timeout = DEFAULT_TIMEOUT_MS) {
  const baseURL = store.get('serverUrl').replace(/\/+$/, '') + '/api/agent';
  const token = store.get('token');
  const http = axios.create({
  baseURL, timeout, maxBodyLength: Infinity, maxContentLength: Infinity,
  headers: { 'X-Agent-Version': app.getVersion(), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  
  http.interceptors.response.use((r) => r, (err) => {
    const url = (err.config && err.config.url) || '';
    // A wrong password on /login is also a 401, so login/logout are excluded.
   if (err.response && err.response.status === 426 && updateHandler) {
    updateHandler(err.response.data);
  }
    return Promise.reject(err);
  });
  return http;
}

module.exports = {
  setUnauthorizedHandler(fn) { unauthorizedHandler = fn; },

  // REMEMBER ME: new 4th argument `remember`, sent to the server so it can
  // issue a long-lived token (30 days) or a short one (1 day).
  async login(serverUrl, email, password, remember = false) {
    store.set('serverUrl', serverUrl);
    const res = await client().post('/login', { email, password, remember: !!remember });
    store.set('token', res.data.token);
    store.set('user', res.data.user);
    store.set('company', res.data.company);
    return res.data;
  },

  async logout() {
    try { await client().post('/logout'); } catch (e) { /* ignore, we clear locally anyway */ }
    store.set('token', null);
    store.set('user', null);
    store.set('company', null);
  },

  async me() {
    const res = await client().get('/me');
    return res.data;
  },

  async startSession(taskId = null) {
    const res = await client().post('/sessions/start', { task_id: taskId });
    return res.data;
  },

  async pauseSession(sessionId) {
    const res = await client().post(`/sessions/${sessionId}/pause`);
    return res.data;
  },

  async resumeSession(sessionId) {
    const res = await client().post(`/sessions/${sessionId}/resume`);
    return res.data;
  },

  async finishSession(sessionId) {
    const res = await client().post(`/sessions/${sessionId}/finish`);
    return res.data;
  },

  async heartbeat(sessionId, payload) {
    const res = await client().post(`/sessions/${sessionId}/heartbeat`, payload);
    return res.data;
  },

  async uploadScreenshot(sessionId, filePath, capturedAt) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('session_id', sessionId);
    form.append('captured_at', capturedAt);
    form.append('screenshot', fs.createReadStream(filePath));
    const res = await client(UPLOAD_TIMEOUT_MS).post('/screenshots', form, {
      headers: form.getHeaders()
    });
    return res.data;
  },

  async reportActivity(payload) {
    const res = await client().post('/activity-reports', payload);
    return res.data;
  },

  async uploadRecording(sessionId, filePath, capturedAt, durationSeconds) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('session_id', sessionId);
    form.append('captured_at', capturedAt);
    form.append('duration_seconds', durationSeconds);
    form.append('recording', fs.createReadStream(filePath));
    const res = await client(UPLOAD_TIMEOUT_MS).post('/recordings', form, {
      headers: form.getHeaders()
    });
    return res.data;
  },

  setUpdateHandler(fn) { updateHandler = fn; },

};