'use strict';
/**
 * preload.js — 管理界面 IPC 桥
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('env:list'),
  create: (data) => ipcRenderer.invoke('env:create', data),
  update: (id, data) => ipcRenderer.invoke('env:update', id, data),
  remove: (id) => ipcRenderer.invoke('env:delete', id),
  start: (id) => ipcRenderer.invoke('env:start', id),
  stop: (id) => ipcRenderer.invoke('env:stop', id),
  openDataDir: () => ipcRenderer.invoke('env:open-data-dir'),
  presets: () => ipcRenderer.invoke('meta:presets'),
  tzOffset: (tz) => ipcRenderer.invoke('meta:tz-offset', tz),
});
