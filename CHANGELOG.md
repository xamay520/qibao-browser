# 七宝浏览器 · 更新日志

## v0.1.4 — 地址栏真正可见 + qibao.online 站点导览（2026-09-12）

- **修复地址栏被网页盖住**：根因是 `envViewBounds` 在环境激活前按旧布局上报，导致内嵌 `WebContentsView` 覆盖了地址栏/标签栏。现在 `refreshList()` 刷新 DOM 并确定 `stage-bar` / `nav-bar` 显隐后再上报坐标，地址栏始终可见。
- **地址栏更像传统浏览器**：加深工具条背景、地址输入框带安全图标（HTTPS 绿锁 / HTTP 黄叹号 / 本地页面地球）、聚焦高亮、加载中提示，一眼就能看到并能点进去改网址。
- **qibao.online 首次访问引导**：当环境加载 `qibao.online` 时自动弹出 5 步站点导览，介绍「推门进入 / 登记身份 / Agent 入口 / 地址栏」等区域，支持跳过/关闭，用 `localStorage` 记住不再重复打扰。
- 冒烟测试全链路通过（`electron . --smoke-test`）：IPC + store + 多视图内嵌并存切换 + 地址栏导航 + 弹窗拦截，`ALL PASS`。

## v0.1.3 — 地址栏导航 + 禁止弹窗（2026-09-10）

- **地址栏改网址可用**：点击环境卡片启动 / 切换到前台后，地址栏回车即可在当前嵌套视图内跳转。裸网址自动补 `https://`（localhost/127 走 `http://`），本地路径 `D:/x` 补成 `file:///` 三斜杠并与 `getURL()` 规范化一致。
- **禁止弹出新窗口**：所有 `<a target="_blank">` / `window.open` / Ctrl+点击 一律通过 `setWindowOpenHandler` 在当前视图内 `loadURL` 打开，不再生成独立原生 `BrowserWindow`。冒烟测试已验证窗口数恒定 = 1。
- **卡片列表自动刷新**：`env:create` / `env:update` 现在触发 `env:list-changed`，渲染端无需手动 `refreshList` 即可刷新卡片（编辑器新建/保存流程更稳）。
- **内置冒烟测试全链路通过**（`electron . --smoke-test`）：IPC + 配置存储 + 多视图内嵌并存切换 + 地址栏导航 + 弹窗拦截，均 `ALL PASS`。
- 附带图标（`icon.ico`）在 v0.1.2 已配置；本版为占位图标，后续可替换为正式品牌图。

## v0.1.2 — 崩溃修复 + 应用图标（2026-09-10）

- 修复 `env:nav-op` 处理器缺少 `async` 导致的 `SyntaxError: await is only valid in async functions`（启动时崩溃）。
- 配置 `build.icon` + 生成 `icon.ico`，修复默认 Electron 图标问题。

## v0.1.0 — 首个可用版本（2026-09-08）

- 本地指纹浏览器：多环境隔离（独立 session / cookie / storage）、代理、指纹伪装（UA / 时区 / Canvas 噪声 / WebGL / 屏幕）。
- 多 `WebContentsView` 内嵌主窗口、显隐切换、多标签管理。
- 导航超时诊断（30s 加载不出只提示不上崩）。
