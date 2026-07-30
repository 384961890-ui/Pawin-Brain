#!/usr/bin/env node
// record-prompt.js — ZCode shim (UserPromptSubmit)
// ZCode 的 Stop hook transcript 只含最后一条 assistant 回复、没有 user 消息，
// capture-lesson 靠扫 user 纠正信号，在 ZCode 下会瞎。
// 此 shim 每轮把 prompt 记进 sessions/<session_id>.jsonl，Stop 时由 stop-transcript-bridge.js 拼回完整 transcript。
// 失败策略：静默退出，绝不阻塞主流程。
const fs = require('fs');
const path = require('path');

const BRAIN_DIR = path.resolve(__dirname, '..');
const ZCODE_DIR = path.join(BRAIN_DIR, 'zcode-shim');
const SESSIONS_DIR = path.join(ZCODE_DIR, 'sessions');
const MAX_BYTES = 200 * 1024; // ponytail: 超 200KB 截到最后 100 行，防长 session 膨胀

function safeSessionId(value) {
  const sanitized = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 160);
  return sanitized || 'unknown';
}

function sessionFile(value) {
  const root = secureSessionsDir();
  const file = path.resolve(root, `${safeSessionId(value)}.jsonl`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw new Error('session path escaped sessions directory');
  }
  return file;
}

function secureSessionsDir() {
  for (const directory of [BRAIN_DIR, ZCODE_DIR]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('unsafe ZCode runtime directory');
    }
  }
  try {
    fs.mkdirSync(SESSIONS_DIR, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(SESSIONS_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('unsafe ZCode sessions directory');
  }
  fs.chmodSync(SESSIONS_DIR, 0o700);
  return path.resolve(SESSIONS_DIR);
}

function appendPrivate(file, line) {
  const flags = fs.constants.O_RDWR |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file, flags, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('unsafe ZCode session file');
    fs.fchmodSync(descriptor, 0o600);
    fs.writeSync(descriptor, line, null, 'utf8');
    const updated = fs.fstatSync(descriptor);
    if (updated.size > MAX_BYTES) {
      const length = Math.min(updated.size, MAX_BYTES);
      const offset = updated.size - length;
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) {
        const firstLineEnd = content.indexOf('\n');
        content = firstLineEnd >= 0 ? content.slice(firstLineEnd + 1) : '';
      }
      const lines = content.split('\n').filter(value => value.trim()).slice(-100);
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, `${lines.join('\n')}\n`, 0, 'utf8');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt;
    if (typeof prompt === 'string' && prompt.trim()) {
      const file = sessionFile(data.session_id ?? data.sessionId);
      appendPrivate(
        file,
        `${JSON.stringify({ role: 'user', content: prompt, ts: Date.now() })}\n`
      );
    }
  } catch {}
  process.stdout.write('{}');
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
