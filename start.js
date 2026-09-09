// 启动包装：剥离 ELECTRON_RUN_AS_NODE 环境变量
// 原因：WorkBuddy 客户端（CodeBuddy，本身为 Electron）会在 Process 级注入
//       ELECTRON_RUN_AS_NODE=1 给所有子 shell，导致 electron.exe 退化为纯 Node
//       模式 → app undefined → 启动即崩。必须在进程启动前清除此变量。
// 详见 .workbuddy/memory/2026-09-08.md

'use strict';
const { spawn } = require('child_process');
const electronPath = require('electron'); // 返回 electron.exe 绝对路径

// 复制环境并移除污染变量
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[start.js] 启动失败:', err.message);
  process.exit(1);
});
