'use strict';
/**
 * url-utils.js — URL 规范化工具（纯函数，不依赖 electron，便于单测）
 *
 * 根因：Chromium 对 file:// 会规范化成三斜杠 file:///D:/...，
 * 而人工输入常写成两斜杠 file://D:/...。若直接拿输入与 webContents.getURL()
 * 比较会永不相等（表现为本地文件导航"切不动/超时"）。统一归一成三斜杠。
 */

function normalizeUrl(url) {
  if (typeof url !== 'string') return url;

  // file:// 1~3 斜杠 → 统一三斜杠 file:///D:/...
  const m = url.match(/^file:(\/){1,3}/);
  if (m) return 'file:///' + url.slice(m[0].length);

  // 裸盘符路径 D:/x 或 D:\x → file:///D:/x（方便直接粘贴本地路径）
  if (/^[a-zA-Z]:[\\/]/.test(url)) {
    const p = url.replace(/\\/g, '/');
    return 'file:///' + p;
  }

  return url;
}

module.exports = { normalizeUrl };
