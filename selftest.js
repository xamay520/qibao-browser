'use strict';
/**
 * selftest.js — 核心逻辑自测（纯 Node，无需 GUI）
 * 运行：node selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    fails.push({ name, err: e });
    console.error('  ✗ ' + name + '\n    ' + (e.message || e).split('\n')[0]);
  }
}

// 在临时目录创建独立的 store
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-selftest-'));
  const { ProfileStore } = require('./store');
  return new ProfileStore(path.join(dir, 'profiles.json'));
}

console.log('== fingerprint-injector ==\n');

const { buildInjectScript, UA_PRESETS, TIMEZONES, WEBGL_PRESETS, tzOffsetMinutes } = require('./fingerprint-injector');

test('buildInjectScript 默认配置生成合法 JS 语法', () => {
  const script = buildInjectScript({});
  assert.ok(script.includes('Object.defineProperty'));
  const file = path.join(os.tmpdir(), 'fp-check-' + Date.now() + '.js');
  fs.writeFileSync(file, script);
  execFileSync(process.execPath, ['--check', file]); // 语法校验
  fs.unlinkSync(file);
});

test('生成脚本包含关键指纹注入点', () => {
  const script = buildInjectScript({
    ua: 'Mozilla/5.0 TEST', platform: 'Win32', language: 'en-US',
    timezone: 'Asia/Tokyo', tzOffset: -540, cores: 4, deviceMemory: 4,
    canvasNoise: true, webglVendor: 'V', webglRenderer: 'R',
  });
  // UA 以 JSON 双引号序列化注入
  for (const key of ['"Mozilla/5.0 TEST"', 'getTimezoneOffset', 'getImageData', 'getParameter', '"Asia/Tokyo"', 'hardwareConcurrency', 'deviceMemory', '"V"', '"R"']) {
    assert.ok(script.includes(key), `缺少 ${key}`);
  }
});

test('UA 配置以 JSON 序列化注入（vm 实际执行无注入）', () => {
  const vm = require('vm');
  const evil = 'Mozilla/5.0"); globalThis.pwned = 1; ("';
  const script = buildInjectScript({ ua: evil, canvasNoise: true });
  // 最小浏览器环境 mock（仅够注入脚本运行）
  const sandbox = {
    window: null, navigator: {}, screen: {},
    Intl, Date, Math, Object, Array, String, JSON, globalThis: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.navigator = { userAgent: '', platform: '', language: '', languages: [], hardwareConcurrency: 0, deviceMemory: 0, maxTouchPoints: 0, vendor: '' };
  sandbox.screen = { width: 0, height: 0, availWidth: 0, availHeight: 0, colorDepth: 0, pixelDepth: 0 };
  sandbox.CanvasRenderingContext2D = function () {};
  sandbox.CanvasRenderingContext2D.prototype = {};
  sandbox.WebGLRenderingContext = function () {};
  sandbox.WebGLRenderingContext.prototype = {};
  sandbox.WebGL2RenderingContext = function () {};
  sandbox.WebGL2RenderingContext.prototype = {};
  sandbox.RTCPeerConnection = function () {};
  sandbox.RTCPeerConnection.prototype = {};
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 2000 });
  assert.strictEqual(sandbox.pwned, undefined, '恶意 UA 被拼接执行');
});

test('时区偏移计算正确', () => {
  assert.strictEqual(tzOffsetMinutes('Asia/Shanghai'), -480);
  assert.strictEqual(tzOffsetMinutes('America/New_York'), 300);
  assert.strictEqual(tzOffsetMinutes('Europe/London'), 0);
});

test('canvas 噪声确定性（同种子输出一致）', () => {
  const a = buildInjectScript({ canvasSeed: 12345 });
  const b = buildInjectScript({ canvasSeed: 12345 });
  assert.strictEqual(a, b);
  const c = buildInjectScript({ canvasSeed: 99999 });
  assert.notStrictEqual(a, c);
});

console.log('\n== ProfileStore ==\n');

test('创建环境有完整默认指纹', () => {
  const store = tmpStore();
  const p = store.create({ name: '环境A' });
  assert.ok(p.id.startsWith('env_'));
  assert.strictEqual(p.name, '环境A');
  assert.ok(p.fingerprint.ua);
  assert.strictEqual(p.fingerprint.canvasNoise, true);
  assert.ok(Number.isInteger(p.fingerprint.canvasSeed));
  assert.ok(store.get(p.id));
});

test('更新环境字段', () => {
  const store = tmpStore();
  const p = store.create({ name: 'A' });
  const upd = store.update(p.id, { name: 'B', proxy: { type: 'socks5', host: '1.2.3.4', port: '1080', username: '', password: '' } });
  assert.strictEqual(upd.name, 'B');
  assert.strictEqual(upd.proxy.type, 'socks5');
  assert.strictEqual(store.get(p.id).proxy.host, '1.2.3.4');
});

test('持久化到磁盘可重载', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-selftest-'));
  const file = path.join(dir, 'profiles.json');
  const s1 = new (require('./store').ProfileStore)(file);
  const p = s1.create({ name: '持久' });
  const s2 = new (require('./store').ProfileStore)(file); // 重新加载
  assert.strictEqual(s2.get(p.id).name, '持久');
});

test('删除环境', () => {
  const store = tmpStore();
  const p = store.create({});
  store.remove(p.id);
  assert.strictEqual(store.get(p.id), null);
});

test('预设数据完整', () => {
  assert.ok(UA_PRESETS.length >= 3);
  assert.ok(TIMEZONES.length >= 6);
  assert.ok(WEBGL_PRESETS.length >= 3);
  for (const u of UA_PRESETS) {
    assert.ok(u.ua.includes('Mozilla/5.0'));
    assert.ok(u.platform);
  }
});

console.log('\n====================');
console.log(`通过 ${passed} · 失败 ${failed}`);
if (failed > 0) {
  console.error('\n失败明细:');
  for (const f of fails) console.error(' - ' + f.name + ': ' + (f.err.stack || f.err));
  process.exit(1);
}
console.log('ALL PASSED');
