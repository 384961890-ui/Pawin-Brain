#!/usr/bin/env node
// stop-transcript-bridge.js — ZCode shim (Stop)
// 用 record-prompt.js 记录的 user 消息 + ZCode 给的 responseText 拼一份 CC 风格
// 完整 transcript，替换 stdin 里的 transcript_path 后原样转喂 capture-lesson.js。
// 原脚本零改动；拼不出来就原 stdin 直通（行为不变差）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRAIN_DIR = path.resolve(__dirname, '..');
const ZCODE_DIR = path.join(BRAIN_DIR, 'zcode-shim');
const CAPTURE = path.join(BRAIN_DIR, 'scripts', 'capture-lesson.js');
const SESSIONS_DIR = path.join(ZCODE_DIR, 'sessions');

function safeSessionId(value) {
  const sanitized = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 160);
  return sanitized || 'unknown';
}

function safeSessionsDir() {
  for (const directory of [BRAIN_DIR, ZCODE_DIR, SESSIONS_DIR]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('unsafe ZCode sessions path');
    }
  }
  return path.resolve(SESSIONS_DIR);
}

function sessionFile(value) {
  const root = safeSessionsDir();
  const file = path.resolve(root, `${safeSessionId(value)}.jsonl`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    throw new Error('session path escaped sessions directory');
  }
  return file;
}

function readPrivateSession(file) {
  if (!file) return '';
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(file, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, 256 * 1024);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstLineEnd = text.indexOf('\n');
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function createPrivateTranscript(lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-zcode-bridge-'));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'transcript.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(file, 0o600);
    return { directory, file };
  } catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  let stdinForChild = input;
  let temporary = null;
  let sessFile = null;
  try {
    const data = JSON.parse(input);
    const sessionId = safeSessionId(data.session_id ?? data.sessionId);
    const normalized = { ...data, session_id: sessionId, sessionId };
    stdinForChild = JSON.stringify(normalized);
    sessFile = sessionFile(sessionId);
    const sessionText = readPrivateSession(sessFile);
    if (sessionText) {
      const userLines = sessionText.split('\n').filter(l => l.trim()).slice(-100);
      const assistantText = data.responseText || data.responsePreview || '';
      const assistantLine = JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
      });
      temporary = createPrivateTranscript([...userLines, assistantLine]);
      stdinForChild = JSON.stringify({
        ...normalized,
        transcript_path: temporary.file,
        transcriptPath: temporary.file,
      });
    }
    const r = spawnSync(process.execPath, [CAPTURE], { input: stdinForChild, encoding: 'utf8', timeout: 12000 });
    if (r.stdout) process.stdout.write(r.stdout);
  } catch {} finally {
    if (temporary) {
      try { fs.rmSync(temporary.directory, { recursive: true, force: true }); } catch {}
    }
    if (sessFile) {
      try {
        safeSessionsDir();
        fs.unlinkSync(sessFile);
      } catch {}
    }
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
