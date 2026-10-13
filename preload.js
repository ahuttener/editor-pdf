'use strict';
// Ponte mínima entre a interface e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  pickPdfs: () => ipcRenderer.invoke('pdf:pickMany'),
  pickImage: () => ipcRenderer.invoke('img:pick'),
  savePdf: (data, opts) => ipcRenderer.invoke('pdf:save', data, opts),
  getFont: (family, variant) => ipcRenderer.invoke('font:get', family, variant),
  fontFamilies: () => ipcRenderer.invoke('font:families'),
  initialFile: () => ipcRenderer.invoke('app:initialFile'),
  setDirty: (value) => ipcRenderer.send('app:dirty', !!value),
  onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, file) => cb(file)),
  testConfig: () => ipcRenderer.invoke('test:config'),
  testScreenshot: (name) => ipcRenderer.invoke('test:screenshot', name),
  testReport: (report) => ipcRenderer.invoke('test:report', report),
});
