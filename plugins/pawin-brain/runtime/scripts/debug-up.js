#!/usr/bin/env node
// debug-up.js — UserPromptSubmit 调试 hook（可选，一次性排查用）
// 证明 host 的 UserPromptSubmit hook 真的被触发；日志写 os.tmpdir()/zcode_up_debug.log。
// 排查完可以从 hook 配置里移除；不移除也无碍——只是多一份日志。
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOG_PATH = path.join(os.tmpdir(), 'zcode_up_debug.log');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const line = `[${new Date().toISOString()}] PID=${process.pid}\n${input}\n---\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  process.stdout.write(JSON.stringify({
    additionalContext: `[debug-up] hook fired at ${new Date().toISOString()}`
  }));
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
