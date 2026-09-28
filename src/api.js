const axios = require('axios');
const fs = require('fs');
const store = require('./store');

function client() {
  const baseURL = store.get('serverUrl').replace(/\/+$/, '') + '/api/agent';
  const token = store.get('token');
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

module.exports = {
  async login(serverUrl, email, password) {
    store.set('serverUrl', serverUrl);
    const res = await client().post('/login', { email, password });
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
    const res = await client().post('/screenshots', form, {
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
    const res = await client().post('/recordings', form, {
      headers: form.getHeaders()
    });
    return res.data;
  }
};