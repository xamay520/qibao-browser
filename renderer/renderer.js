'use strict';
/* 七宝浏览器 — 渲染进程逻辑 */

const api = window.api;

const state = {
  presets: null,
  editingId: null, // null = 新建
};

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 预设加载 ----------
async function loadPresets() {
  state.presets = await api.presets();
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
  const list = await api.list();
  const grid = $('env-list');
  $('empty-tip').hidden = list.length > 0;

  // 清掉除 empty-tip 外的卡片
  grid.querySelectorAll('.card').forEach((n) => n.remove());

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card' + (p.running ? ' running' : '');
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
        <span style="font-size:11px;color:var(--text-dim)">${p.running ? '运行中' : '已停止'}</span>
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
      if (!opBtn) { openEditor(p.id); return; }
      const op = opBtn.dataset.op;
      if (op === 'toggle') toggleEnv(p.id, p.running);
      else if (op === 'edit') openEditor(p.id);
      else if (op === 'del') deleteEnv(p.id);
      e.stopPropagation();
    });

    grid.appendChild(card);
  }
}

async function toggleEnv(id, running) {
  if (running) {
    await api.stop(id);
  } else {
    const r = await api.start(id);
    if (!r.ok) alert(r.message || '启动失败');
  }
  refreshList();
}

async function deleteEnv(id) {
  if (!confirm(`确定删除环境「${id}」？\n（浏览器数据也会一并删除，不可恢复）`)) return;
  await api.remove(id);
  refreshList();
}

// ---------- 编辑面板 ----------
function openEditor(id) {
  state.editingId = id;
  $('editor-title').textContent = id ? '编辑环境' : '新建环境';
  $('editor-error').textContent = '';
  $('editor-mask').hidden = false;

  if (id) {
    api.list().then((list) => {
      const p = list.find((x) => x.id === id);
      if (p) fillForm(p);
    });
  } else {
    fillForm(null);
  }
}

function closeEditor() {
  $('editor-mask').hidden = true;
  state.editingId = null;
}

function fillForm(p) {
  const fp = p ? p.fingerprint || {} : {};
  const proxy = p ? p.proxy || {} : {};
  $('f-name').value = p ? p.name : '';
  $('f-homepage').value = p ? p.homepage || 'https://www.baidu.com' : 'https://www.baidu.com';

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
  if (!name) { $('editor-error').textContent = '请填写环境名称'; return null; }

  const proxy = {
    type: $('f-proxy-type').value,
    host: $('f-proxy-host').value.trim(),
    port: $('f-proxy-port').value.trim(),
    username: $('f-proxy-user').value.trim(),
    password: $('f-proxy-pass').value,
  };
  if (proxy.type && !proxy.host) { $('editor-error').textContent = '填写了代理类型就必须填主机'; return null; }

  const uaPresetVal = $('f-ua-preset').value;
  let ua = '', platform = '', language = 'zh-CN';
  if (uaPresetVal === '__custom__') {
    ua = $('f-ua-custom').value.trim();
    if (!ua) { $('editor-error').textContent = '自定义 UA 不能为空'; return null; }
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
    homepage: $('f-homepage').value.trim() || 'https://www.baidu.com',
    proxy,
    fingerprint,
  };
}

async function saveEditor() {
  const data = collectForm();
  if (!data) return;
  if (state.editingId) {
    await api.update(state.editingId, data);
  } else {
    await api.create(data);
  }
  closeEditor();
  refreshList();
}

// ---------- 事件绑定 ----------
function bind() {
  $('btn-new').addEventListener('click', () => openEditor(null));
  $('btn-editor-close').addEventListener('click', closeEditor);
  $('btn-editor-cancel').addEventListener('click', closeEditor);
  $('btn-editor-save').addEventListener('click', saveEditor);
  $('btn-data-dir').addEventListener('click', () => api.openDataDir());
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
})();
