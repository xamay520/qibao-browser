# 七宝浏览器

七宝浏览器（本地指纹浏览器）：多环境隔离 · 代理 · 指纹伪装。Electron 自研，数据全部存本机，不上传。

> 新手第一次用？先看 **[《七宝浏览器使用说明.md》](七宝浏览器使用说明.md)**，每个空怎么填都写了。

## 运行

**双击 `start.cmd` 即可**（推荐）。

或命令行：

```bash
npm install          # 首次
npm start            # 启动管理界面
```

> 💡 如果你需要：系统设置过 `ELECTRON_RUN_AS_NODE=1`（会让 Electron 退化为 Node 模式、应用起不来）或 C 盘空间紧张，请用 `start.cmd` 启动——它会自动清除该变量、并把 Chromium 临时目录重定向到应用目录旁 `_tmp/`（避免写系统盘）。

## 功能

- **多环境隔离**：每个环境独立 `session` 分区（`persist:env-<id>`），cookie / localStorage / 缓存完全隔离
- **代理**：HTTP / HTTPS / SOCKS5，按环境独立设置，支持账号密码认证
- **指纹伪装**（JS 层注入，随环境动态生成 preload）：
  - UA / platform / language（含 HTTP 层 UA 同步）
  - 时区（`getTimezoneOffset` / `Date.toString` 平移 / `Intl.resolvedOptions`）
  - Canvas 噪声（确定性加噪，同环境每次结果一致）
  - WebGL vendor / renderer（VENDOR / RENDERER / UNMASKED 四项）
  - `hardwareConcurrency` / `deviceMemory` / `maxTouchPoints`
  - 可选屏幕分辨率伪装
  - WebRTC IP 泄漏防护（全局 `disable_non_proxied_udp`，隐藏真实 IP，走代理时用代理出口）
- **管理界面**：环境卡片列表、新建/编辑/删除、启动/停止、数据目录直达

## 目录结构

```
fingerprint-browser/
├── main.js                  # 主进程：环境/代理/窗口/IPC
├── preload.js               # 管理界面 IPC 桥
├── store.js                 # 环境配置 JSON 持久化
├── fingerprint-injector.js  # 指纹注入脚本生成（核心）
├── selftest.js              # 核心逻辑自测
└── renderer/                # 深色管理界面
    ├── index.html
    ├── style.css
    └── renderer.js
```

## 数据位置

- 环境配置：`<userData>/profiles.json`（应用目录旁 `user-data/profiles.json`）
- 环境浏览器数据：`<userData>/env-data/`
- 指纹注入脚本：`<userData>/preloads/env-<id>.js`

## 已知边界（重要）

- **JS 层指纹**能过普通关联检测（cookie/UA/时区/Canvas），**防不了专业反指纹**（银行、风控级别会检测内核级特征）
- 代理凭证明文存于 `profiles.json`，本机可信前提下使用
- 删除环境会连同浏览器数据一起删除，不可恢复
- `contextIsolation: false` 用于环境窗口（指纹注入需主世界），请勿在环境窗口访问不可信本地页面

## 自测

```bash
npm run selftest
```

## 路线图（未做）

- 窗口同步（CDP 转发点击/输入/滚动）
- RPA 自动化 / 本地 API
- 代理连通性测试
- 指纹检测报告页（打开 target 页看指纹是否生效）

## License

MIT License，详见 [LICENSE](LICENSE)。
