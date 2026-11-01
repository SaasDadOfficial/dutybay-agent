const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  login: (serverUrl, email, password, remember) =>
  ipcRenderer.invoke('agent:login', serverUrl, email, password, remember),
  logout: () => ipcRenderer.invoke('agent:logout'),
  getState: () => ipcRenderer.invoke('agent:getState'),
  start: () => ipcRenderer.invoke('agent:start'),
  pause: () => ipcRenderer.invoke('agent:pause'),
  resume: () => ipcRenderer.invoke('agent:resume'),
  finish: () => ipcRenderer.invoke('agent:finish'),
  onStateUpdate: (callback) => ipcRenderer.on('agent:state', (_event, state) => callback(state))
});
