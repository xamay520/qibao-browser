'use strict';
/* 七宝浏览器 — 渲染进程逻辑 */

const bridge = window.api;

const state = {
  presets: null,
  editingId: null, // null = 新建
  activeId: null,  // 当前显示在舞台上的环境 id
};

// 各运行环境的导航状态缓存：id -> {url, canBack, canFwd}（主进程 did-navigate 回推）
const navCache = {};

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 预设加载 ----------
async function loadPresets() {
  state.presets = await bridge.presets();
  const uaSel = $('f-ua-preset');
  uaSel.innerHTML = state.presets.ua.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('') +
    '<option value="__custom__">自定义 UA…</option>';

  const tzSel = $('f-timezone');
  tzSel.innerHTML = state.presets.timezones.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');

  const glSel = $('f-webgl');
  glSel.innerHTML = state.presets.webgl.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join('');
}

// ---------- 环境列表 ----------
async function refreshList() {
  const list = await bridge.list();
  const envList = $('env-list');
  $('empty-tip').hidden = list.length > 0;
  $('env-count').textContent = String(list.length);

  // 清掉除 empty-tip 外的卡片
  envList.querySelectorAll('.card').forEach((n) => n.remove());

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card' + (p.running ? ' running' : '') + (p.active ? ' active' : '');
    card.dataset.id = p.id;

    const proxy = p.proxy && p.proxy.host
      ? `${(p.proxy.type || 'http').toUpperCase()} ${p.proxy.host}:${p.proxy.port}`
      : '无代理';
    const fpBits = [];
    if (p.fingerprint) {
      const uaShort = String(p.fingerprint.ua || '').match(/Chrome\/([\d.]+)/);
      fpBits.push(uaShort ? 'Chrome ' + uaShort[1] : 'UA');
      fpBits.push(p.fingerprint.timezone || '时区');
      fpBits.push(p.fingerprint.canvasNoise ? 'Canvas✓' : 'Canvas✗');
    }

    card.innerHTML = `
      <div class="card-head">
        <span class="card-name"><span class="dot ${p.running ? 'on' : ''}"></span>${esc(p.name)}</span>
        <span style="font-size:11px;color:var(--text-dim)">${p.running ? (p.active ? '当前显示' : '运行中') : '已停止'}</span>
      </div>
      <div class="card-meta">
        <div class="kv"><span class="k">代理</span><span class="v">${esc(proxy)}</span></div>
        <div class="kv"><span class="k">指纹</span><span class="v">${esc(fpBits.join(' · ') || '默认')}</span></div>
        <div class="kv"><span class="k">主页</span><span class="v">${esc(p.homepage || '-')}</span></div>
      </div>
      <div class="card-ops">
        <span class="spacer"></span>
        <button class="btn sm ${p.running ? 'danger' : ''}" data-op="toggle">${p.running ? '停止' : '启动'}</button>
        <button class="btn sm" data-op="edit">编辑</button>
        <button class="btn sm danger" data-op="del">删除</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      const opBtn = e.target.closest('[data-op]');
      if (opBtn) {
        const op = opBtn.dataset.op;
        if (op === 'toggle') toggleEnv(p.id, p.running);
        else if (op === 'edit') openEditor(p.id);
        else if (op === 'del') deleteEnv(p.id);
        e.stopPropagation();
        return;
      }
      // 点卡片主体：运行中 → 切到前台；已停止 → 启动
      if (p.running) activateEnv(p.id);
      else startEnv(p.id);
    });

    envList.appendChild(card);
  }

  renderTabs(list);
  applyNav(list);
}

// ---------- 浏览器工具条（地址栏 / 后退前进刷新主页） ----------
// 工具条属于"当前 active 环境"：active 变化时归属跟着变
function applyNav(list) {
  const active = (list || []).find((p) => p.active) || null;
  state.activeId = active ? active.id : null;
  $('nav-bar').hidden = !active;
  applyNavBar();
}

// 把地址栏值/按钮态刷成当前 active 环境的缓存状态
function applyNavBar() {
  const bar = $('nav-bar');
  if (!bar || bar.hidden || !state.activeId) return;
  const st = navCache[state.activeId] || { url: '', canBack: false, canFwd: false };
  const input = $('nav-url');
  if (document.activeElement !== input) input.value = st.url; // 用户正在输入时不清空
  input.placeholder = st.url ? '输入网址，回车访问' : '加载中… 输入网址回车访问';
  $('nav-back').disabled = !st.canBack;
  $('nav-fwd').disabled = !st.canFwd;
}

async function goNavOp(op) {
  if (!state.activeId) return;
  await bridge.navOp(state.activeId, op);
}

async function navToUrl() {
  if (!state.activeId) return;
  const input = $('nav-url');
  let v = input.value.trim();
  if (!v) return;
  // 裸盘符路径 D:/x 或 D:\x → 补成 file:/// 三斜杠（与 Chromium getURL() 一致）
  if (/^[a-zA-Z]:[\\/]/.test(v)) {
    v = 'file:///' + v.replace(/\\/g, '/');
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
    // 无协议：localhost/127 开头走 http，其余按 https 处理
    v = /^(localhost|127\.|\[::1\])/.test(v) ? 'http://' + v : 'https://' + v;
  }
  input.blur();
  await bridge.navigate(state.activeId, v);
}

// 导航诊断（超时/失败）：短暂提示到地址栏右侧，8s 后自动消失
let navDiagTimer = null;
function showNavDiag(p) {
  const el = $('nav-diag');
  if (!el) return;
  el.textContent = (p && p.message) || '加载异常';
  el.classList.toggle('err', !!(p && p.error));
  el.hidden = false;
  if (navDiagTimer) clearTimeout(navDiagTimer);
  navDiagTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

// 顶部标签条：每个运行中的环境一个标签，点击切换、× 停止
function renderTabs(list) {
  const running = list.filter((p) => p.running);
  const bar = $('stage-bar');
  bar.hidden = running.length === 0;
  const tabs = $('stage-tabs');
  tabs.querySelectorAll('.env-tab').forEach((n) => n.remove());

  for (const p of running) {
    const tab = document.createElement('div');
    tab.className = 'env-tab' + (p.active ? ' active' : '');
    tab.title = p.homepage || p.name;
    tab.innerHTML =
      `<span class="tab-dot"></span>` +
      `<span class="tab-name">${esc(p.name)}</span>` +
      `<button class="tab-x" title="停止并关闭">×</button>`;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-x')) {
        e.stopPropagation();
        bridge.stop(p.id).then(() => { reportViewBounds(); refreshList(); });
        return;
      }
      bridge.activate(p.id).then(() => refreshList());
    });
    tabs.appendChild(tab);
  }

  // 没有任何环境被激活显示时，舞台给出引导
  $('stage-empty').hidden = list.some((p) => p.active);
}

// 把舞台（#view-host）的实际位置告诉主进程，让内嵌视图精确贴齐（避开顶部标签栏）
function reportViewBounds() {
  const el = $('view-host');
  if (!el) return;
  const r = el.getBoundingClientRect();
  bridge.viewBounds({
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.round(r.width), height: Math.round(r.height),
  });
}

async function toggleEnv(id, running) {
  if (running) {
    await bridge.stop(id);
  } else {
    const r = await bridge.start(id);
    if (!r.ok) alert(r.message || '启动失败');
  }
  reportViewBounds();
  refreshList();
}

async function startEnv(id) {
  const r = await bridge.start(id);
  if (!r.ok) alert(r.message || '启动失败');
  reportViewBounds();
  refreshList();
}

async function activateEnv(id) {
  const r = await bridge.activate(id);
  if (!r.ok && r.message !== '未在运行') alert(r.message || '切换失败');
  reportViewBounds();
  refreshList();
}

// 编辑面板是 DOM 遮罩层；内嵌视图是原生层会盖住遮罩 → 打开面板时隐藏视图，关闭时恢复
function setEditorOpen(open) {
  if (open) {
    $('editor-mask').hidden = false;
    bridge.setViewVisible(false);
  } else {
    $('editor-mask').hidden = true;
    state.editingId = null;
    setEditorError('');
    bridge.setViewVisible(true);
  }
}

async function deleteEnv(id) {
  if (!confirm(`确定删除环境「${id}」？\n（浏览器数据也会一并删除，不可恢复）`)) return;
  await bridge.remove(id);
  refreshList();
}

// ---------- 编辑面板 ----------
function openEditor(id) {
  state.editingId = id;
  $('editor-title').textContent = id ? '编辑环境' : '新建环境';
  setEditorError('');
  setEditorOpen(true); // 隐藏内嵌视图，避免盖住遮罩层

  if (id) {
    bridge.list().then((list) => {
      const p = list.find((x) => x.id === id);
      if (p) fillForm(p);
    });
  } else {
    fillForm(null);
  }
}

function closeEditor() {
  setEditorOpen(false);
}

function setEditorError(msg) {
  const el = $('editor-error');
  el.textContent = msg || '';
  el.hidden = !msg;
  if (msg) console.error('[editor]', msg);
}

function fillForm(p) {
  const fp = p ? p.fingerprint || {} : {};
  const proxy = p ? p.proxy || {} : {};
  $('f-name').value = p ? p.name : '';
  $('f-homepage').value = p ? p.homepage || 'https://qibao.online' : 'https://qibao.online';

  $('f-proxy-type').value = proxy.type || '';
  $('f-proxy-host').value = proxy.host || '';
  $('f-proxy-port').value = proxy.port || '';
  $('f-proxy-user').value = proxy.username || '';
  $('f-proxy-pass').value = proxy.password || '';

  // UA：匹配预设，否则自定义
  const uaPreset = state.presets.ua.find((u) => u.ua === fp.ua);
  if (uaPreset) {
    $('f-ua-preset').value = uaPreset.id;
    $('f-ua-custom').value = '';
  } else {
    $('f-ua-preset').value = '__custom__';
    $('f-ua-custom').value = fp.ua || '';
  }

  $('f-timezone').value = fp.timezone || 'Asia/Shanghai';
  $('f-cores').value = fp.cores || 8;
  $('f-memory').value = fp.deviceMemory || 8;

  const gl = state.presets.webgl.find((g) => g.vendor === fp.webglVendor && g.renderer === fp.webglRenderer);
  $('f-webgl').value = gl ? gl.id : state.presets.webgl[0].id;

  $('f-swidth').value = fp.screen ? fp.screen.width : '';
  $('f-sheight').value = fp.screen ? fp.screen.height : '';
  $('f-canvas').checked = fp.canvasNoise !== false;
}

// UA 预设联动
function onUaPresetChange() {
  const v = $('f-ua-preset').value;
  if (v === '__custom__') return;
  const p = state.presets.ua.find((u) => u.id === v);
  if (p) {
    $('f-ua-custom').value = '';
    // 语言跟随预设
    $('f-timezone').value = $('f-timezone').value || 'Asia/Shanghai';
  }
}

function collectForm() {
  const name = $('f-name').value.trim();
  if (!name) { setEditorError('请填写环境名称'); return null; }

  const proxy = {
    type: $('f-proxy-type').value,
    host: $('f-proxy-host').value.trim(),
    port: $('f-proxy-port').value.trim(),
    username: $('f-proxy-user').value.trim(),
    password: $('f-proxy-pass').value,
  };
  if (proxy.type && !proxy.host) { setEditorError('填写了代理类型就必须填主机'); return null; }

  const uaPresetVal = $('f-ua-preset').value;
  let ua = '', platform = '', language = 'zh-CN';
  if (uaPresetVal === '__custom__') {
    ua = $('f-ua-custom').value.trim();
    if (!ua) { setEditorError('自定义 UA 不能为空'); return null; }
    platform = 'Win32';
  } else {
    const p = state.presets.ua.find((u) => u.id === uaPresetVal);
    ua = p.ua; platform = p.platform; language = p.language;
  }

  const tzId = $('f-timezone').value;
  const tz = state.presets.timezones.find((t) => t.id === tzId) || state.presets.timezones[0];
  const gl = state.presets.webgl.find((g) => g.id === $('f-webgl').value) || state.presets.webgl[0];

  const sw = $('f-swidth').value.trim();
  const sh = $('f-sheight').value.trim();
  const screen = sw && sh ? { width: Number(sw), height: Number(sh), depth: 24 } : null;

  const fingerprint = {
    ua, platform, language,
    timezone: tz.id,
    tzOffset: tz.offset,
    cores: Number($('f-cores').value) || 8,
    deviceMemory: Number($('f-memory').value) || 8,
    canvasNoise: $('f-canvas').checked,
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    screen,
  };

  return {
    name,
    homepage: $('f-homepage').value.trim() || 'https://qibao.online',
    proxy,
    fingerprint,
  };
}

async function saveEditor() {
  const data = collectForm();
  if (!data) return;
  try {
    if (state.editingId) {
      await bridge.update(state.editingId, data);
    } else {
      await bridge.create(data);
    }
    closeEditor();
    refreshList();
  } catch (e) {
    setEditorError('保存失败：' + (e && e.message || e));
  }
}

// ---------- 事件绑定 ----------
function bind() {
  $('btn-new').addEventListener('click', () => openEditor(null));
  $('btn-editor-close').addEventListener('click', closeEditor);
  $('btn-editor-cancel').addEventListener('click', closeEditor);
  $('btn-editor-save').addEventListener('click', saveEditor);
  $('btn-data-dir').addEventListener('click', () => bridge.openDataDir());
  $('nav-back').addEventListener('click', () => goNavOp('back'));
  $('nav-fwd').addEventListener('click', () => goNavOp('forward'));
  $('nav-reload').addEventListener('click', () => goNavOp('reload'));
  $('nav-home').addEventListener('click', () => goNavOp('home'));
  $('nav-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navToUrl();
    else if (e.key === 'Escape') { e.target.value = navCache[state.activeId] ? navCache[state.activeId].url : ''; e.target.blur(); }
  });
  $('nav-url').addEventListener('focus', (e) => { if (e.target.value) e.target.select(); });
  $('btn-vpngate-help').addEventListener('click', () => {
    bridge.openVpngate();
    $('vpngate-tips').open = true;
    // vpngate 公共中继账号固定 vpn/vpn：帮用户预填，省得手动输
    const u = $('f-proxy-user'), pw = $('f-proxy-pass');
    if (!u.value.trim()) u.value = 'vpn';
    if (!pw.value.trim()) pw.value = 'vpn';
  });
  $('f-ua-preset').addEventListener('change', onUaPresetChange);
  $('editor-mask').addEventListener('click', (e) => {
    if (e.target === $('editor-mask')) closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('editor-mask').hidden) closeEditor();
  });
}

// ---------- 启动 ----------
(async function init() {
  bind();
  await loadPresets();
  await refreshList();
  reportViewBounds();
  window.addEventListener('resize', () => reportViewBounds());
  // 环境被停止/关闭 → 主进程通知刷新卡片与标签
  bridge.onListChanged(() => refreshList());
  // 主窗口缩放 → 主进程请求重报舞台坐标
  bridge.onRequestBounds(() => reportViewBounds());
  // 页面导航变化 → 主进程回推 URL/可后退/可前进，驱动地址栏
  bridge.onNavigated((p) => {
    if (!p || !p.id) return;
    navCache[p.id] = { url: p.url || '', canBack: !!p.canBack, canFwd: !!p.canFwd };
    applyNavBar();
  });
  // 导航超时/失败诊断（30s 加载不出 / 本地文件不存在等）
  bridge.onDiagnostic((p) => showNavDiag(p));
})();
