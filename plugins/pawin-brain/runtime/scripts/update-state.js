#!/usr/bin/env node
/**
 * update-state.js — claude-brain v2.0 状态更新器
 *
 * 用法:
 *   node update-state.js                  → 仅刷新时间戳（Stop hook 调）
 *   node update-state.js --show           → 显示当前 STATE.md
 *
 * 不破坏人工编辑的"当前心境""关系动态"段。
 * STATE.md 由人手动编辑核心内容（脑写），只自动更新时间戳。
 */

const path = require('path');
const fs = require('fs');
const { BRAIN_DIR, readFileSafe, writeFileAtomic, nowReadable } = require('./util.js');

const args = process.argv.slice(2);
const statePath = path.join(BRAIN_DIR, 'STATE.md');

if (args.includes('--show')) {
  process.stdout.write(readFileSafe(statePath, '(STATE.md 不存在)'));
  process.exit(0);
}

const state = readFileSafe(statePath);
if (!state) {
  process.stderr.write('STATE.md 不存在\n');
  process.exit(1);
}

// 只更新顶部时间戳
const updated = state.replace(
  /最后更新：[^\n]+/,
  `最后更新：${nowReadable()}（自动）`
);

try {
  writeFileAtomic(statePath, updated);
  // 静默 - Stop hook 不需要输出
  process.exit(0);
} catch (e) {
  process.stderr.write(`update failed: ${e.message}\n`);
  process.exit(1);
}
