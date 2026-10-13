'use strict';
// Ponte mínima entre a interface e o processo principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('file:open'),
  pickFiles: (kind) => ipcRenderer.invoke('file:pickMany', kind),
  noteOpened: (path) => ipcRenderer.invoke('file:noteOpened', path),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentOpen: (path) => ipcRenderer.invoke('recent:open', path),
  recentClear: () => ipcRenderer.invoke('recent:clear'),
  savePdf: (data, opts) => ipcRenderer.invoke('pdf:save', data, opts),
  saveFileAs: (data, opts) => ipcRenderer.invoke('file:saveAs', data, opts),
  pickDir: (title) => ipcRenderer.invoke('dir:pick', title),
  writeToDir: (dir, files) => ipcRenderer.invoke('dir:write', dir, files),
  showInFolder: (target) => ipcRenderer.invoke('shell:show', target),
  engine: (op, args) => ipcRenderer.invoke('engine', op, args),
  print: () => ipcRenderer.invoke('print'),
  getFont: (family, variant) => ipcRenderer.invoke('font:get', family, variant),
  fontFamilies: () => ipcRenderer.invoke('font:families'),
  initialFile: () => ipcRenderer.invoke('app:initialFile'),
  setDirty: (value) => ipcRenderer.send('app:dirty', !!value),
  onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, file) => cb(file)),
  onEngineProgress: (cb) => ipcRenderer.on('engine:progress', (_e, info) => cb(info)),
  platform: process.platform,
  pathForFile: (file) => { try { const p = webUtils.getPathForFile(file); if (p) ipcRenderer.send('file:dropped', p); return p || null; } catch { return null; } },
  setLang: (lang) => ipcRenderer.send('app:setLang', lang),
  testConfig: () => ipcRenderer.invoke('test:config'),
  testScreenshot: (name) => ipcRenderer.invoke('test:screenshot', name),
  testReport: (report) => ipcRenderer.invoke('test:report', report),
});
