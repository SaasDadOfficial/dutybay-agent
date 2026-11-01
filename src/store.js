const Store = require('electron-store');

const store = new Store({
  name: 'dutybay-agent-config',
  defaults: {
    serverUrl: 'https://dutybay.com/',
    token: null,
    user: null,
    company: null,
    lastSessionId: null,
    lastSessionDate: null
  }
});

module.exports = store;
