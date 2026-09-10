'use strict';
/**
 * main.js — 七宝浏览器主进程
 * 环境管理 / 独立 session 隔离 / 代理 / 指纹注入 / 窗口生命周期
 */

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildInjectScript, UA_PRESETS, TIMEZONES, WEBGL_PRESETS, tzOffsetMinutes } = require('./fingerprint-injector');
const { ProfileStore } = require('./store');
const { normalizeUrl } = require('./url-utils');

// ---------- 便携化 userData ----------
// 开发版：数据放在项目旁的 user-data/，避免 C 盘空间不足，也便于整体备份迁移。
// 发行版（electron-builder 打包后）：__dirname 位于只读 asar，不能写；
//   故保持 electron 默认 userData（OS appData，可写）。
// 测试/多实例可用环境变量 QIBAO_USER_DATA 覆盖到隔离目录。
// 必须在任何 getPath('userData') 之前设置。
try {
  const userDataOverride = process.env.QIBAO_USER_DATA;
  if (userDataOverride) {
    app.setPath('userData', userDataOverride);
  } else if (!app.isPackaged) {
    app.setPath('userData', path.join(__dirname, 'user-data'));
  }
  // app.isPackaged 且无覆盖 → 使用系统默认 userData（可写）
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

// ---------- 单实例锁 ----------
// 防止重复启动（如连点桌面图标）导致多个实例并发读写 user-data/ 互相冲突
// 表现为：点保存没反应、数据丢失、界面异常。第二个实例自动退出并聚焦已有窗口。
if (!isSmokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;           // 管理界面（左侧环境列表 + 右侧浏览器舞台）
const envViews = new Map();      // id -> WebContentsView（每个环境一个内嵌视图，并存可切换）
let activeEnvId = null;          // 当前显示在舞台上的环境 id
let envViewBounds = null;        // 舞台布局 {x,y,width,height}（由 renderer 上报）

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

// ---------- 带超时的导航加载（超时只诊断不上崩） ----------
// v3 根因修复：本地 file:// 路径若与 getURL() 规范形式不一致会"切不动/超时"。
// 这里统一先 normalize，并给 loadURL 加 30s 超时——超时/失败只向 renderer 上报诊断，
// 不 reject（页面可能仍在后台加载），避免 UI 假死。
const NAV_TIMEOUT_MS = 30000;
function loadWithTimeout(view, url, profileId) {
  const wc = view.webContents;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const msg = `加载超过 ${NAV_TIMEOUT_MS / 1000}s 未结束（可能：本地文件不存在 / 无网络 / 资源被墙阻塞）`;
      console.warn(`[nav] env ${profileId} 超时 ${NAV_TIMEOUT_MS}ms: ${url}`);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('env:nav-diagnostic', { id: profileId, message: msg, url });
      }
      resolve({ ok: true, timedOut: true });
    }, NAV_TIMEOUT_MS);
    wc.loadURL(url).then(() => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ ok: true });
    }).catch((e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const msg = '加载失败：' + ((e && e.message) || e);
      console.warn(`[nav] env ${profileId} 失败: ${url} -> ${msg}`);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('env:nav-diagnostic', { id: profileId, message: msg, url, error: true });
      }
      resolve({ ok: false, message: msg });
    });
  });
}

// ---------- 环境视图（多 WebContentsView 内嵌主窗口，显隐切换） ----------

// 把所有环境视图贴到同一舞台区域（同一时刻只显示一个）
function applyAllViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let b = envViewBounds;
  if (!b) {
    // 尚未收到 renderer 上报：默认铺满右侧（左侧管理栏约 340px）
    const [w, h] = mainWindow.getContentSize();
    b = { x: 340, y: 0, width: Math.max(300, w - 340), height: h };
  }
  for (const v of envViews.values()) {
    try { v.setBounds(b); } catch (_) {}
  }
}

// 只显示 id 对应视图，其余隐藏。id=null 时全部隐藏（编辑面板打开等场景）
function showEnvView(id) {
  activeEnvId = id;
  for (const [k, v] of envViews) {
    try { v.setVisible(k === id); } catch (_) {}
  }
}

// 主窗口所有内容视图统一显隐（编辑面板遮罩场景）
function setAllViewsVisible(visible) {
  for (const [, v] of envViews) {
    try { v.setVisible(!!visible); } catch (_) {}
  }
}

// 把某环境视图的导航状态（URL / 能否后退前进）推给 renderer，驱动地址栏
function emitNavState(profileId) {
  const v = envViews.get(profileId);
  if (!v || v.webContents.isDestroyed()) return;
  const wc = v.webContents;
  let url = '', canBack = false, canFwd = false;
  try {
    url = wc.getURL();
    canBack = wc.navigationHistory.canGoBack();
    canFwd = wc.navigationHistory.canGoForward();
  } catch (_) {}
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('env:navigated', { id: profileId, url, canBack, canFwd });
  }
}

// 切换到一个已在运行的环境（不重建，直接显隐切换）
function activateEnv(profileId) {
  if (!envViews.has(profileId)) return { ok: false, message: '未在运行' };
  const v = envViews.get(profileId);
  if (!v || v.webContents.isDestroyed()) {
    envViews.delete(profileId);
    return { ok: false, message: '未在运行' };
  }
  showEnvView(profileId);
  emitNavState(profileId); // 切换后立即把该环境的当前 URL/按钮态推给地址栏
  return { ok: true, message: '已切换' };
}

// 启动环境：首次创建视图挂进主窗口；已在运行则切换到前台
async function startEnv(profileId) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, message: '主窗口未就绪' };

  // 已在运行 → 切到前台（页面状态保留，不重新加载）
  const existing = envViews.get(profileId);
  if (existing && !existing.webContents.isDestroyed()) {
    showEnvView(profileId);
    return { ok: true, message: '已切换' };
  }
  envViews.delete(profileId); // 清残留

  const profile = store.get(profileId);
  if (!profile) return { ok: false, message: '环境不存在' };

  const preload = writeEnvPreload(profile);
  const ses = await setupSession(profile);

  const view = new WebContentsView({
    webPreferences: {
      preload,
      contextIsolation: false,                 // 指纹注入需要主世界
      nodeIntegration: false,
      partition: `persist:env-${profileId}`,   // 各环境 cookie/storage 持久化互不干扰
      sandbox: false,
    },
  });
  envViews.set(profileId, view);

  view.webContents.on('destroyed', () => {
    envViews.delete(profileId);
    if (activeEnvId === profileId) activeEnvId = null;
    notifyListChanged();
  });

  // 页面导航变化 → 通知 renderer 同步地址栏（did-fail-load 兜底：输入错误网址也回显）
  const wc = view.webContents;
  wc.on('did-navigate', () => emitNavState(profileId));
  wc.on('did-navigate-in-page', () => emitNavState(profileId));
  wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) emitNavState(profileId);
  });

  mainWindow.contentView.addChildView(view);
  applyAllViewBounds();
  showEnvView(profileId);   // 隐藏其它视图、显示新环境

  // HTTP 层 UA 与 JS 层 navigator.userAgent 保持一致
  if (profile.fingerprint?.ua) ses.setUserAgent(profile.fingerprint.ua);

  // 导航开始即回推一次（地址栏及时跟随，不必等加载完成）
  wc.on('did-start-loading', () => emitNavState(profileId));

  // 所有新窗口请求（<a target="_blank"> / window.open / Ctrl+点击）一律在当前视图内打开，
  // 不弹独立原生窗口——指纹浏览器应始终待在主界面里。
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    try { wc.loadURL(openUrl); } catch (_) {}
    return { action: 'deny' };
  });

  const homepage = normalizeUrl(profile.homepage || 'https://qibao.online');
  await loadWithTimeout(view, homepage, profileId); // 规范化 + 超时诊断
  return { ok: true, message: '已启动' };
}

function stopEnv(profileId) {
  const view = envViews.get(profileId);
  if (!view) return { ok: false, message: '未在运行' };
  try { mainWindow?.contentView.removeChildView(view); } catch (_) {}
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (_) {}
  envViews.delete(profileId);
  if (activeEnvId === profileId) {
    // 停止的是当前显示的环境 → 把 active 移交给第一个仍在运行的环境
    const next = [...envViews.keys()].find((id) => envStatus(id)) || null;
    activeEnvId = next;
    if (next) showEnvView(next);
  }
  notifyListChanged();
  return { ok: true, message: '已停止' };
}

function envStatus(profileId) {
  const v = envViews.get(profileId);
  return !!(v && !v.webContents.isDestroyed());
}

function envActive(profileId) {
  return envStatus(profileId) && activeEnvId === profileId;
}

// 通知 renderer 刷新卡片（环境关闭/停止时）
function notifyListChanged() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('env:list-changed');
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('env:list', () => store.list().map((p) => ({ ...p, running: envStatus(p.id), active: envActive(p.id) })));
  ipcMain.handle('env:create', (_e, data) => {
    const profile = store.create(data);
    writeEnvPreload(profile);
    notifyListChanged(); // 新建后通知渲染端刷新卡片列表（无需手动 refreshList）
    return { ...profile, running: false };
  });
  ipcMain.handle('env:update', (_e, id, data) => {
    const profile = store.update(id, data);
    if (profile) {
      writeEnvPreload(profile);
      // 运行中则重启以应用新配置
      if (envStatus(id)) { stopEnv(id); startEnv(id); }
      notifyListChanged(); // 更新后通知渲染端刷新卡片列表
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
  ipcMain.handle('env:activate', (_e, id) => activateEnv(id));
  // 地址栏跳转：无协议自动补 https://，file:// 规范化
  ipcMain.handle('env:navigate', (_e, id, rawUrl) => {
    const v = envViews.get(id);
    if (!v || v.webContents.isDestroyed()) return { ok: false, message: '环境未在运行' };
    let url = String(rawUrl || '').trim();
    if (!url) return { ok: false, message: '网址为空' };
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    url = normalizeUrl(url); // 两斜杠 → 三斜杠，避免与 getURL() 不一致
    return loadWithTimeout(v, url, id).then(() => ({ ok: true }));
  });
  // 工具条操作：back / forward / reload / home
  ipcMain.handle('env:nav-op', async (_e, id, op) => {
    const v = envViews.get(id);
    if (!v || v.webContents.isDestroyed()) return { ok: false, message: '环境未在运行' };
    try {
      const wc = v.webContents;
      const nav = wc.navigationHistory;
      if (op === 'back') { if (nav.canGoBack()) nav.goBack(); }
      else if (op === 'forward') { if (nav.canGoForward()) nav.goForward(); }
      else if (op === 'reload') { wc.reload(); }
      else if (op === 'home') {
        const p = store.get(id);
        const home = normalizeUrl(p && p.homepage ? p.homepage : 'https://qibao.online');
        await loadWithTimeout(v, home, id);
      }
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
    return { ok: true };
  });
  ipcMain.handle('env:view-bounds', (_e, rect) => {
    if (rect && typeof rect.x === 'number') { envViewBounds = rect; applyAllViewBounds(); }
    return { ok: true };
  });
  ipcMain.handle('env:view-visible', (_e, visible) => {
    // 编辑面板打开时全部隐藏；关闭时恢复显示当前活动环境
    if (visible) {
      if (activeEnvId) showEnvView(activeEnvId);
    } else {
      setAllViewsVisible(false);
    }
    return { ok: true };
  });
  ipcMain.handle('env:open-data-dir', () => {
    const dir = ENV_USER_DATA();
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = require('electron');
    shell.openPath(dir);
    return { ok: true };
  });
  ipcMain.handle('meta:presets', () => ({ ua: UA_PRESETS, timezones: TIMEZONES, webgl: WEBGL_PRESETS }));
  ipcMain.handle('meta:tz-offset', (_e, tz) => tzOffsetMinutes(tz));
  ipcMain.handle('meta:open-vpngate', () => {
    const { shell } = require('electron');
    shell.openExternal('https://www.vpngate.net/cn/');
    return { ok: true };
  });
}

// ---------- 主窗口 ----------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    title: '七宝浏览器 · 环境管理',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 管理窗口关闭 → 销毁所有环境视图，避免孤儿进程
    for (const [, v] of envViews) {
      try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch (_) {}
    }
    envViews.clear();
    activeEnvId = null;
  });
  // 窗口缩放时请求 renderer 重新上报内容区坐标，所有视图同步贴齐
  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('env:request-bounds');
    }
  });
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  fs.mkdirSync(ENV_USER_DATA(), { recursive: true });
  registerIpc();
  createMainWindow();

  if (isSmokeTest) {
    // 冒烟测试：等窗口加载完成后验证 IPC 链路 + 独立窗口生成 + title，然后退出
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

        // 内嵌多视图验证：start 后不应产生新 BrowserWindow
        const started = await mainWindow.webContents.executeJavaScript(`window.api.start(${JSON.stringify(created)})`);
        if (!started || !started.ok) throw new Error('start() 失败: ' + (started && started.message));
        await new Promise((r) => setTimeout(r, 600));
        const winCount = BrowserWindow.getAllWindows().length;
        if (winCount !== 1) throw new Error('内嵌模式下应只有 1 个 BrowserWindow，实际 ' + winCount);
        const v1 = envViews.get(created);
        if (!v1 || v1.webContents.isDestroyed()) throw new Error('环境视图未注册到 envViews Map');
        if (activeEnvId !== created) throw new Error('启动后应激活该环境');
        const bounds = v1.getBounds();
        if (!(bounds.width > 200 && bounds.height > 200)) throw new Error('视图 bounds 异常: ' + JSON.stringify(bounds));

        // 并存验证：启动第二个环境，两个视图都存活，且切换后 active 正确
        const created2 = await mainWindow.webContents.executeJavaScript(
          'window.api.create({ name: "__smoke2__", homepage: "about:blank" }).then(r => r.id)'
        );
        const started2 = await mainWindow.webContents.executeJavaScript(`window.api.start(${JSON.stringify(created2)})`);
        if (!started2 || !started2.ok) throw new Error('start2() 失败');
        await new Promise((r) => setTimeout(r, 600));
        if (envViews.size !== 2) throw new Error('两环境应并存，实际视图数 ' + envViews.size);
        if (activeEnvId !== created2) throw new Error('切到第二环境后 active 应更新');
        // 切回第一个：不应重建视图（对象相同）
        const v1Again = envViews.get(created);
        if (v1Again !== v1) throw new Error('切换不应重建视图');
        const back = await mainWindow.webContents.executeJavaScript(`window.api.activate(${JSON.stringify(created)})`);
        if (!back || !back.ok) throw new Error('activate() 失败');
        if (activeEnvId !== created) throw new Error('切回第一环境后 active 应更新');

        // 导航测试：地址栏 navigate 应真正改变视图 URL（验证"能不能改网址"）
        const targetFile = 'file:///' + path.join(__dirname, 'renderer', 'index.html').replace(/\\/g, '/');
        const navRes = await mainWindow.webContents.executeJavaScript(
          `window.api.navigate(${JSON.stringify(created)}, ${JSON.stringify(targetFile)})`
        );
        if (!navRes || !navRes.ok) throw new Error('navigate() 返回: ' + JSON.stringify(navRes));
        await new Promise((r) => setTimeout(r, 1500));
        const navUrl = v1.webContents.getURL();
        if (!/index\.html$/.test(navUrl)) throw new Error('navigate 后视图 URL 未变更: ' + navUrl);

        // 新窗口拦截测试：视图内 window.open 应被当前视图 loadURL，且不产生新 BrowserWindow
        const winBefore = BrowserWindow.getAllWindows().length;
        await v1.webContents.executeJavaScript(`window.open(${JSON.stringify(targetFile)})`);
        await new Promise((r) => setTimeout(r, 1500));
        const winAfter = BrowserWindow.getAllWindows().length;
        if (winAfter !== winBefore) throw new Error('setWindowOpenHandler 未生效，窗口数 ' + winBefore + '→' + winAfter);
        const openUrl = v1.webContents.getURL();
        if (!/index\.html$/.test(openUrl)) throw new Error('window.open 后当前视图 URL 未变更: ' + openUrl);

        // 渲染端导航测试：直接走 navToUrl 完整链路（activeId 已由前面的 start/activate → refreshList → applyNav 设置）
        const rendererTarget = 'file:///' + path.join(__dirname, 'url-utils.js').replace(/\\/g, '/');
        const rdbg = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const inp = document.getElementById('nav-url');
            if (!inp) return { err: 'nav-url 输入不存在' };
            inp.value = ${JSON.stringify(rendererTarget)};
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return {};
          })()
        `);
        await new Promise((r) => setTimeout(r, 1800));
        const rNavUrl = v1.webContents.getURL();
        if (!/url-utils\.js$/.test(rNavUrl)) throw new Error('渲染端 navToUrl 后视图 URL 未变更: ' + rNavUrl);

        // 停止 + 清理
        await mainWindow.webContents.executeJavaScript(`window.api.stop(${JSON.stringify(created2)})`);
        await new Promise((r) => setTimeout(r, 300));
        await mainWindow.webContents.executeJavaScript(`window.api.stop(${JSON.stringify(created)})`);
        await new Promise((r) => setTimeout(r, 300));
        await mainWindow.webContents.executeJavaScript(`window.api.remove(${JSON.stringify(created2)})`);
        await mainWindow.webContents.executeJavaScript(`window.api.remove(${JSON.stringify(created)})`);
        writeSmoke('ALL PASS: IPC + store + 多视图内嵌并存切换 全链路 OK\n');
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
