#!/usr/bin/env node
/**
 * zcode-hook-router.js — ZCode host adapter for claude-brain
 *
 * Modes:
 *   inject-context          Explicitly select ZCode's light context mode
 *   post-tool-use           Forward successful tool telemetry
 *   post-tool-use-failure   Mark and forward failed tool telemetry
 *   stop                    Rebuild a full transcript and fan out Stop hooks
 *
 * The router is the only ZCode-specific boundary. Shared scripts remain
 * host-agnostic, and Claude Code never receives the ZCode host signal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRAIN_DIR = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.resolve(__dirname, '..')
);
const ZCODE_DIR = path.join(BRAIN_DIR, 'zcode-shim');
const SESSIONS_DIR = path.join(ZCODE_DIR, 'sessions');
const MODE = process.argv[2] || '';

const SCRIPTS = {
  injectContext: path.join(BRAIN_DIR, 'scripts', 'inject-context.js'),
  trackBehavior: path.join(BRAIN_DIR, 'scripts', 'track-behavior.js'),
  stopAudit: path.join(BRAIN_DIR, 'v2', 'scripts', 'stop-audit.js'),
  finishWork: path.join(BRAIN_DIR, 'v2', 'scripts', 'finish-the-work.js'),
  thinkDetect: path.join(BRAIN_DIR, 'v3', 'scripts', 'think-detect.js'),
  captureLesson: path.join(BRAIN_DIR, 'scripts', 'capture-lesson.js'),
  updateState: path.join(BRAIN_DIR, 'scripts', 'update-state.js'),
};
const STOP_TIMEOUTS = Object.freeze({
  stopAudit: 5000,
  finishWork: 5000,
  thinkDetect: 5000,
  captureLesson: 9000,
  updateState: 4000,
});
const STOP_BUDGET_MS = 38000;

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

function normalizeSession(payload) {
  const normalized = safeSessionId(payload.session_id ?? payload.sessionId);
  return { ...payload, session_id: normalized, sessionId: normalized };
}

function readOnce() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (input += chunk));
  process.stdin.on('end', () => {
    try {
      if (MODE === 'inject-context') return routeInjectContext(input);
      if (MODE === 'post-tool-use') return routeToolEvent(input, false);
      if (MODE === 'post-tool-use-failure') return routeToolEvent(input, true);
      if (MODE === 'stop') return routeStop(input);
    } catch {}
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

function runScript(script, stdin, options = {}) {
  try {
    return spawnSync(process.execPath, [script], {
      input: stdin,
      encoding: 'utf8',
      timeout: options.timeout || 10000,
      env: {
        ...process.env,
        CLAUDE_BRAIN_DIR: BRAIN_DIR,
        CLAUDE_BRAIN_HOST: 'zcode',
        ...(options.env || {}),
      },
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function deadlineBudget(totalMs) {
  const deadline = Date.now() + totalMs;
  return (capMs, reserveMs = 0) => Math.max(
    0,
    Math.min(capMs, deadline - Date.now() - reserveMs)
  );
}

function runBudgeted(script, stdin, timeout) {
  return timeout > 0 ? runScript(script, stdin, { timeout }) : null;
}

function relayValidJson(stdout) {
  const text = (stdout || '').trim();
  if (!text) return;
  try {
    JSON.parse(text);
    process.stdout.write(text);
  } catch {}
}

function routeInjectContext(stdin) {
  let payload;
  try { payload = JSON.parse(stdin || '{}'); } catch { payload = {}; }
  const remaining = deadlineBudget(8000);
  const result = runBudgeted(
    SCRIPTS.injectContext,
    JSON.stringify(normalizeSession(payload)),
    remaining(7500)
  );
  if (result) relayValidJson(result.stdout);
  process.exit(0);
}

function routeToolEvent(stdin, isFailure) {
  let payload;
  try { payload = JSON.parse(stdin || '{}'); } catch { payload = {}; }
  payload = normalizeSession(payload);
  payload.hook_event_name = isFailure ? 'PostToolUseFailure' : 'PostToolUse';
  payload.hookEventName = payload.hook_event_name;
  const remaining = deadlineBudget(8000);
  runBudgeted(SCRIPTS.trackBehavior, JSON.stringify(payload), remaining(7500));
  process.exit(0);
}

function readPrivateFile(file, maxBytes = 256 * 1024) {
  if (!file) return '';
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(file, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, maxBytes);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-zcode-stop-'));
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

function buildTranscript(payload, promptFile) {
  const lines = [];

  const promptText = readPrivateFile(promptFile);
  if (promptText) {
    const userLines = promptText
      .split('\n')
      .filter(line => line.trim())
      .slice(-100);
    for (const line of userLines) {
      try {
        const message = JSON.parse(line);
        lines.push(JSON.stringify({
          role: 'user',
          content: message.content || '',
          message: {
            role: 'user',
            content: [{ type: 'text', text: message.content || '' }],
          },
        }));
      } catch {}
    }
  }

  const assistantText = payload.responseText || payload.responsePreview || '';
  if (assistantText) {
    lines.push(JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
      },
    }));
  }

  if (lines.length === 0) return null;
  return createPrivateTranscript(lines);
}

function routeStop(stdin) {
  let payload;
  try { payload = JSON.parse(stdin || '{}'); } catch { payload = {}; }
  payload = normalizeSession(payload);

  let temporary = null;
  let promptFile = null;
  try { promptFile = sessionFile(payload.session_id); } catch {}
  let finishOutput = '';
  const remaining = deadlineBudget(STOP_BUDGET_MS);
  try {
    temporary = buildTranscript(payload, promptFile);
    const transcriptPath = temporary && temporary.file;
    const adapted = transcriptPath
      ? { ...payload, transcript_path: transcriptPath, transcriptPath }
      : payload;
    const adaptedInput = JSON.stringify(adapted);

    if (temporary) {
      runBudgeted(
        SCRIPTS.stopAudit,
        adaptedInput,
        remaining(STOP_TIMEOUTS.stopAudit, STOP_TIMEOUTS.updateState + 1000)
      );
      const finish = runBudgeted(
        SCRIPTS.finishWork,
        adaptedInput,
        remaining(STOP_TIMEOUTS.finishWork, STOP_TIMEOUTS.updateState + 1000)
      );
      if (finish) finishOutput = finish.stdout || '';
      runBudgeted(
        SCRIPTS.thinkDetect,
        adaptedInput,
        remaining(STOP_TIMEOUTS.thinkDetect, STOP_TIMEOUTS.updateState + 1000)
      );
      runBudgeted(
        SCRIPTS.captureLesson,
        adaptedInput,
        remaining(STOP_TIMEOUTS.captureLesson, STOP_TIMEOUTS.updateState + 1000)
      );
    }
  } catch {} finally {
    runBudgeted(
      SCRIPTS.updateState,
      JSON.stringify(payload),
      remaining(STOP_TIMEOUTS.updateState)
    );
    if (temporary) {
      try { fs.rmSync(temporary.directory, { recursive: true, force: true }); } catch {}
    }
    if (promptFile) {
      try {
        safeSessionsDir();
        fs.unlinkSync(promptFile);
      } catch {}
    }
  }

  relayValidJson(finishOutput);
  process.exit(0);
}

if (require.main === module) readOnce();

module.exports = {
  STOP_BUDGET_MS,
  STOP_TIMEOUTS,
  buildTranscript,
  deadlineBudget,
  readPrivateFile,
  safeSessionId,
  safeSessionsDir,
  sessionFile,
};
