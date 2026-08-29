'use strict';
/**
 * main.js — 七宝浏览器主进程
 * 环境管理 / 独立 session 隔离 / 代理 / 指纹注入 / 窗口生命周期
 */

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildInjectScript, UA_PRESETS, TIMEZONES, WEBGL_PRESETS, tzOffsetMinutes } = require('./fingerprint-injector');
const { ProfileStore } = require('./store');

// ---------- 便携化 userData ----------
// 数据放在应用目录旁的 user-data/（D 盘），避免 C 盘空间不足导致运行失败，
// 也便于整体备份迁移。必须在任何 getPath('userData') 之前设置。
try {
  app.setPath('userData', path.join(__dirname, 'user-data'));
} catch (_) {}

// ---------- 全局指纹相关开关 ----------
// 老机器/无独显环境 GPU 进程易崩，默认软件渲染（对指纹一致性也有好处）
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('in-process-gpu');
// 隐藏真实 IP：非代理 UDP 直连禁用，只走 TCP（或代理）
app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
// 关闭自动更新等噪音
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const isDev = !app.isPackaged;

// ---------- 冒烟测试模式 ----------
// 用法：electron . --smoke-test
// 验证主进程 + 渲染进程 + IPC 全链路，2 秒后自动退出
const isSmokeTest = process.argv.includes('--smoke-test');

let mainWindow = null;        // 管理界面
const envWindows = new Map(); // id -> BrowserWindow

const store = new ProfileStore(path.join(app.getPath('userData'), 'profiles.json'));

const PRELOAD_DIR = () => path.join(app.getPath('userData'), 'preloads');
const PRELOAD_FILE = (id) => path.join(PRELOAD_DIR(), `env-${id}.js`);
const ENV_USER_DATA = () => path.join(app.getPath('userData'), 'env-data');

// 代理规则转换
function proxyRulesFrom(proxy) {
  if (!proxy || !proxy.host || !proxy.port) return null;
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http';
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

// 生成/更新环境的 preload 注入文件
function writeEnvPreload(profile) {
  fs.mkdirSync(PRELOAD_DIR(), { recursive: true });
  const script = buildInjectScript(profile.fingerprint || {});
  const file = PRELOAD_FILE(profile.id);
  fs.writeFileSync(file, script, 'utf8');
  return file;
}

function deleteEnvPreload(id) {
  try { fs.unlinkSync(PRELOAD_FILE(id)); } catch (_) {}
}

// 配置 session：代理 + 认证
async function setupSession(profile) {
  const ses = session.fromPartition(`persist:env-${profile.id}`, { cache: true });
  const rules = proxyRulesFrom(profile.proxy);
  if (rules) {
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
  } else {
    await ses.setProxy({ mode: 'system' });
  }
  // 代理认证
  ses.on('login', (event, _wc, _details, authInfo, callback) => {
    const p = profile.proxy;
    if (p && p.username && p.password) {
      event.preventDefault();
      callback(p.username, p.password);
    } else {
      callback();
    }
  });
  return ses;
}

// 启动一个环境窗口
async function startEnv(profileId) {
  if (envWindows.has(profileId)) {
    const win = envWindows.get(profileId);
    if (!win.isDestroyed()) { win.focus(); return { ok: true, message: '已在前台' }; }
    envWindows.delete(profileId);
  }
  const profile = store.get(profileId);
  if (!profile) return { ok: false, message: '环境不存在' };

  const preload = writeEnvPreload(profile);
  const ses = await setupSession(profile);

  const win = new BrowserWindow({
    width: profile.fingerprint?.screen?.width || 1280,
    height: profile.fingerprint?.screen?.height || 800,
    minWidth: 640,
    minHeight: 480,
    title: profile.name,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: false,   // 指纹注入需要主世界
      nodeIntegration: false,
      partition: `persist:env-${profileId}`,
      sandbox: false,
    },
  });

  // HTTP 层 UA 与 JS 层 navigator.userAgent 保持一致
  if (profile.fingerprint?.ua) {
    ses.setUserAgent(profile.fingerprint.ua);
  }

  envWindows.set(profileId, win);
  win.on('closed', () => envWindows.delete(profileId));

  const homepage = profile.homepage || 'https://www.baidu.com';
  await win.loadURL(homepage);
  return { ok: true, message: '已启动' };
}

function stopEnv(profileId) {
  const win = envWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    win.close();
    envWindows.delete(profileId);
    return { ok: true, message: '已停止' };
  }
  return { ok: false, message: '未在运行' };
}

function envStatus(profileId) {
  const win = envWindows.get(profileId);
  return !!(win && !win.isDestroyed());
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('env:list', () => store.list().map((p) => ({ ...p, running: envStatus(p.id) })));
  ipcMain.handle('env:create', (_e, data) => {
    const profile = store.create(data);
    writeEnvPreload(profile);
    return { ...profile, running: false };
  });
  ipcMain.handle('env:update', (_e, id, data) => {
    const profile = store.update(id, data);
    if (profile) {
      writeEnvPreload(profile);
      // 运行中则重启以应用新配置
      if (envStatus(id)) { stopEnv(id); startEnv(id); }
    }
    return profile ? { ...profile, running: envStatus(id) } : null;
  });
  ipcMain.handle('env:delete', (_e, id) => {
    stopEnv(id);
    deleteEnvPreload(id);
    store.remove(id);
    return { ok: true };
  });
  ipcMain.handle('env:start', (_e, id) => startEnv(id));
  ipcMain.handle('env:stop', (_e, id) => stopEnv(id));
  ipcMain.handle('env:open-data-dir', () => {
    const dir = ENV_USER_DATA();
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = require('electron');
    shell.openPath(dir);
    return { ok: true };
  });
  ipcMain.handle('meta:presets', () => ({ ua: UA_PRESETS, timezones: TIMEZONES, webgl: WEBGL_PRESETS }));
  ipcMain.handle('meta:tz-offset', (_e, tz) => tzOffsetMinutes(tz));
}

// ---------- 主窗口 ----------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: 'FB Manager 指纹浏览器',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  fs.mkdirSync(ENV_USER_DATA(), { recursive: true });
  registerIpc();
  createMainWindow();

  if (isSmokeTest) {
    // 冒烟测试：等窗口加载完成后验证 IPC 链路，然后退出
    const smokeResult = path.join(__dirname, 'smoke-result.txt');
    const writeSmoke = (text) => { try { fs.writeFileSync(smokeResult, text, 'utf8'); } catch (_) {} };
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const list = await mainWindow.webContents.executeJavaScript('window.api.list()');
        if (!Array.isArray(list)) throw new Error('list() 未返回数组');
        const created = await mainWindow.webContents.executeJavaScript(
          'window.api.create({ name: "__smoke__", homepage: "about:blank" }).then(r => r.id)'
        );
        if (!created) throw new Error('create() 返回空');
        const listed = await mainWindow.webContents.executeJavaScript('window.api.list()');
        const found = listed.some((p) => p.id === created);
        if (!found) throw new Error('create 后 list 未包含新环境');
        // 清理冒烟环境
        await mainWindow.webContents.executeJavaScript(`window.api.remove(${JSON.stringify(created)})`);
        writeSmoke('ALL PASS: renderer IPC + store 全链路 OK\n');
        console.log('[smoke] ALL PASS');
      } catch (e) {
        writeSmoke('FAIL: ' + (e && e.message || String(e)) + '\n');
        console.error('[smoke] FAIL:', e);
        process.exitCode = 1;
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // 环境窗口全关时也退出（管理界面即主窗口）
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { envStatus };
