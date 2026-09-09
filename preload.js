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
  activate: (id) => ipcRenderer.invoke('env:activate', id),
  navigate: (id, url) => ipcRenderer.invoke('env:navigate', id, url),
  navOp: (id, op) => ipcRenderer.invoke('env:nav-op', id, op),
  viewBounds: (rect) => ipcRenderer.invoke('env:view-bounds', rect),
  setViewVisible: (visible) => ipcRenderer.invoke('env:view-visible', visible),
  openDataDir: () => ipcRenderer.invoke('env:open-data-dir'),
  openVpngate: () => ipcRenderer.invoke('meta:open-vpngate'),
  onListChanged: (cb) => ipcRenderer.on('env:list-changed', () => cb()),
  onRequestBounds: (cb) => ipcRenderer.on('env:request-bounds', () => cb()),
  onNavigated: (cb) => ipcRenderer.on('env:navigated', (_e, payload) => cb(payload)),
  presets: () => ipcRenderer.invoke('meta:presets'),
  tzOffset: (tz) => ipcRenderer.invoke('meta:tz-offset', tz),
});
