'use strict';
/**
 * fingerprint-injector.js
 * 根据环境配置动态生成指纹注入脚本（在主世界执行）。
 * 注入位置：环境窗口的 preload（contextIsolation:false 时主世界生效）。
 */

// ---- 预设数据 ----

const UA_PRESETS = [
  {
    id: 'win-chrome-126',
    label: 'Windows · Chrome 126',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'zh-CN',
  },
  {
    id: 'win-edge-126',
    label: 'Windows · Edge 126',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    platform: 'Win32',
    language: 'zh-CN',
  },
  {
    id: 'mac-chrome-126',
    label: 'macOS · Chrome 126',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    language: 'en-US',
  },
  {
    id: 'mac-safari-17',
    label: 'macOS · Safari 17',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'MacIntel',
    language: 'en-US',
  },
];

const TIMEZONES = [
  { id: 'Asia/Shanghai', label: '中国 · 上海 (UTC+8)', offset: -480 },
  { id: 'Asia/Hong_Kong', label: '中国 · 香港 (UTC+8)', offset: -480 },
  { id: 'Asia/Tokyo', label: '日本 · 东京 (UTC+9)', offset: -540 },
  { id: 'Asia/Singapore', label: '新加坡 (UTC+8)', offset: -480 },
  { id: 'Europe/London', label: '英国 · 伦敦 (UTC+0)', offset: 0 },
  { id: 'Europe/Berlin', label: '德国 · 柏林 (UTC+1)', offset: -60 },
  { id: 'America/New_York', label: '美国 · 纽约 (UTC-5)', offset: 300 },
  { id: 'America/Los_Angeles', label: '美国 · 洛杉矶 (UTC-8)', offset: 480 },
];

const WEBGL_PRESETS = [
  {
    id: 'nvidia-rtx3060',
    label: 'NVIDIA RTX 3060 (Windows)',
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'intel-uhd630',
    label: 'Intel UHD 630 (Windows)',
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    id: 'apple-m1',
    label: 'Apple M1 (macOS)',
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
  },
];

// ---- 工具 ----

function tzOffsetMinutes(tzId) {
  const tz = TIMEZONES.find((t) => t.id === tzId);
  return tz ? tz.offset : -480;
}

// ---- 注入脚本生成 ----

/**
 * 生成主世界注入脚本。
 * @param {object} fp 指纹配置
 * @returns {string} JS 代码
 */
function buildInjectScript(fp) {
  const cfg = {
    ua: String(fp.ua || UA_PRESETS[0].ua),
    platform: String(fp.platform || 'Win32'),
    language: String(fp.language || 'zh-CN'),
    timezone: String(fp.timezone || 'Asia/Shanghai'),
    tzOffset: Number.isFinite(Number(fp.tzOffset)) ? Number(fp.tzOffset) : tzOffsetMinutes(fp.timezone),
    cores: Math.max(2, Math.min(64, Number(fp.cores) || 8)),
    deviceMemory: Math.max(2, Math.min(64, Number(fp.deviceMemory) || 8)),
    canvasNoise: fp.canvasNoise !== false,
    canvasSeed: Number(fp.canvasSeed) || Math.floor(Math.random() * 1e9),
    webglVendor: String(fp.webglVendor || 'Google Inc. (NVIDIA)'),
    webglRenderer: String(fp.webglRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    maxTouchPoints: Number(fp.maxTouchPoints) || 0,
    screen: fp.screen && fp.screen.width ? fp.screen : null,
  };

  // 所有配置 JSON 序列化注入，避免拼接注入问题
  const CFG = JSON.stringify(cfg);

  return `(() => {
  const FP = ${CFG};
  const define = (obj, prop, val) => {
    try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (_) {}
  };

  // ---------- navigator ----------
  define(navigator, 'userAgent', FP.ua);
  define(navigator, 'appVersion', FP.ua.replace('Mozilla/', ''));
  define(navigator, 'platform', FP.platform);
  define(navigator, 'language', FP.language);
  define(navigator, 'languages', Object.freeze([FP.language]));
  define(navigator, 'hardwareConcurrency', FP.cores);
  define(navigator, 'deviceMemory', FP.deviceMemory);
  define(navigator, 'maxTouchPoints', FP.maxTouchPoints);
  define(navigator, 'vendor', 'Google Inc.');
  define(navigator, 'webdriver', undefined);

  // ---------- 屏幕 ----------
  if (FP.screen) {
    const sw = FP.screen.width, sh = FP.screen.height, sd = FP.screen.depth || 24;
    try {
      Object.defineProperties(screen, {
        width: { get: () => sw, configurable: true },
        height: { get: () => sh, configurable: true },
        availWidth: { get: () => sw, configurable: true },
        availHeight: { get: () => sh, configurable: true },
        colorDepth: { get: () => sd, configurable: true },
        pixelDepth: { get: () => sd, configurable: true },
      });
    } catch (_) {}
    try {
      Object.defineProperties(window, {
        outerWidth: { get: () => sw, configurable: true },
        outerHeight: { get: () => sh, configurable: true },
      });
    } catch (_) {}
  }

  // ---------- 时区（Date / Intl）----------
  const origGetTZ = Date.prototype.getTimezoneOffset;
  const origToString = Date.prototype.toString;
  const origToLocaleString = Date.prototype.toLocaleString;
  const origToLocaleDateString = Date.prototype.toLocaleDateString;
  const origToLocaleTimeString = Date.prototype.toLocaleTimeString;
  const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;

  Date.prototype.getTimezoneOffset = function () { return FP.tzOffset; };

  // 将时间平移为目标时区的显示值（保持内部时间不变）
  const shift = (d) => new Date(d.getTime() + (origGetTZ.call(d) - FP.tzOffset) * 60000);
  Date.prototype.toString = function () { return origToString.call(shift(this)); };
  Date.prototype.toLocaleString = function (loc, opts) {
    return origToLocaleString.call(shift(this), loc, opts);
  };
  Date.prototype.toLocaleDateString = function (loc, opts) {
    return origToLocaleDateString.call(shift(this), loc, opts);
  };
  Date.prototype.toLocaleTimeString = function (loc, opts) {
    return origToLocaleTimeString.call(shift(this), loc, opts);
  };
  Intl.DateTimeFormat.prototype.resolvedOptions = function () {
    const r = origResolved.call(this);
    try { r.timeZone = FP.timezone; } catch (_) {}
    return r;
  };
  try { define(Intl.DateTimeFormat, 'timeZone', FP.timezone); } catch (_) {}

  // ---------- Canvas 噪声（确定性）----------
  if (FP.canvasNoise) {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const seed = FP.canvasSeed >>> 0;
    CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
      const img = origGetImageData.call(this, x, y, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const idx = ((i / 4) + seed) >>> 0;
        const h1 = ((idx * 2654435761) >>> 0) % 255;
        if (h1 < 8) {
          d[i] = (d[i] + (h1 % 2 === 0 ? 1 : -1) + 256) % 256;
        }
      }
      return img;
    };
  }

  // ---------- WebGL 参数 ----------
  const glParams = {
    0x1F00: FP.webglVendor,   // VENDOR
    0x1F01: FP.webglRenderer, // RENDERER
    0x9245: FP.webglVendor,   // UNMASKED_VENDOR_WEBGL
    0x9246: FP.webglRenderer, // UNMASKED_RENDERER_WEBGL
  };
  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function (param) {
      return glParams[param] !== undefined ? glParams[param] : orig.call(this, param);
    };
  };
  patchGL(WebGLRenderingContext.prototype);
  patchGL(WebGL2RenderingContext.prototype);

  // ---------- WebRTC 兜底（主要靠主进程开关）----------
  try {
    const origCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
      if (label && String(label).toLowerCase().includes('webrtc')) {
        return origCreate.call(this, 'dc_' + (Math.random() * 1e6 | 0), opts);
      }
      return origCreate.call(this, label, opts);
    };
  } catch (_) {}

  // ---------- 性能标记 ----------
  try { define(navigator, 'pdfViewerEnabled', true); } catch (_) {}
  try { define(navigator, 'userAgentData', undefined); } catch (_) {}
})();`;
}

module.exports = {
  buildInjectScript,
  UA_PRESETS,
  TIMEZONES,
  WEBGL_PRESETS,
  tzOffsetMinutes,
};
