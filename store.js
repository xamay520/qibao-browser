'use strict';
/**
 * store.js — 环境配置持久化（JSON 文件）
 */

const fs = require('fs');
const crypto = require('crypto');
const { UA_PRESETS, TIMEZONES, WEBGL_PRESETS, tzOffsetMinutes } = require('./fingerprint-injector');

function newId() {
  return 'env_' + crypto.randomBytes(6).toString('hex');
}

function defaultFingerprint() {
  const ua = UA_PRESETS[0];
  const tz = TIMEZONES[0];
  const gl = WEBGL_PRESETS[0];
  return {
    ua: ua.ua,
    platform: ua.platform,
    language: ua.language,
    timezone: tz.id,
    tzOffset: tz.offset,
    cores: 8,
    deviceMemory: 8,
    canvasNoise: true,
    canvasSeed: Math.floor(Math.random() * 1e9),
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    maxTouchPoints: 0,
    screen: null,
  };
}

class ProfileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = [];
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      this.data = [];
    }
  }

  _save() {
    const dir = require('path').dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return this.data;
  }

  get(id) {
    return this.data.find((p) => p.id === id) || null;
  }

  create(input = {}) {
    const fp = {
      ...defaultFingerprint(),
      ...(input.fingerprint || {}),
    };
    const profile = {
      id: newId(),
      name: String(input.name || '新环境'),
      createdAt: Date.now(),
      homepage: input.homepage || 'https://qibao.online',
      proxy: input.proxy || { type: '', host: '', port: '', username: '', password: '' },
      fingerprint: fp,
    };
    this.data.push(profile);
    this._save();
    return profile;
  }

  update(id, patch = {}) {
    const profile = this.get(id);
    if (!profile) return null;
    if (patch.name !== undefined) profile.name = String(patch.name);
    if (patch.homepage !== undefined) profile.homepage = String(patch.homepage);
    if (patch.proxy !== undefined) {
      profile.proxy = {
        type: String(patch.proxy.type || ''),
        host: String(patch.proxy.host || ''),
        port: String(patch.proxy.port || ''),
        username: String(patch.proxy.username || ''),
        password: String(patch.proxy.password || ''),
      };
    }
    if (patch.fingerprint !== undefined) {
      profile.fingerprint = { ...profile.fingerprint, ...patch.fingerprint };
    }
    this._save();
    return profile;
  }

  remove(id) {
    this.data = this.data.filter((p) => p.id !== id);
    this._save();
  }
}

module.exports = { ProfileStore };
