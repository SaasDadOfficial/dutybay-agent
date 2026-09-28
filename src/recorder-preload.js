const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderBridge', {
  onStart: (callback) => ipcRenderer.on('recorder:start', (_e, opts) => callback(opts)),
  sendDone: (arrayBuffer) => ipcRenderer.send('recorder:done', arrayBuffer),
  sendError: (message) => ipcRenderer.send('recorder:error', message)
});