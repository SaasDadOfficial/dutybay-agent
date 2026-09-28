const Store = require('electron-store');

const store = new Store({
  name: 'dutybay-agent-config',
  defaults: {
    serverUrl: 'http://127.0.0.1:8000',
    token: null,
    user: null,
    company: null,
    lastSessionId: null,
    lastSessionDate: null
  }
});

module.exports = store;
