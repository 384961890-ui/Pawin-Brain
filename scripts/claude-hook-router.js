#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BRAIN_DIR = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.join(require('os').homedir(), '.claude-brain')
);
const MODE = process.argv[2] || '';
const SCRIPTS = {
  injectContext: path.join(ROOT, 'scripts', 'inject-context.js'),
  injectProtocol: path.join(ROOT, 'v2', 'scripts', 'inject-protocol-v2.js'),
  trackBehavior: path.join(ROOT, 'scripts', 'track-behavior.js'),
  smellCheck: path.join(ROOT, 'scripts', 'smell-check.js'),
  stopAudit: path.join(ROOT, 'v2', 'scripts', 'stop-audit.js'),
  finishWork: path.join(ROOT, 'v2', 'scripts', 'finish-the-work.js'),
  thinkDetect: path.join(ROOT, 'v3', 'scripts', 'think-detect.js'),
  captureLesson: path.join(ROOT, 'scripts', 'capture-lesson.js'),
  updateState: path.join(ROOT, 'scripts', 'update-state.js')
};
const STOP_HANDLERS = [
  { script: SCRIPTS.stopAudit, timeout: 4000 },
  { script: SCRIPTS.finishWork, timeout: 4000, relay: true },
  { script: SCRIPTS.thinkDetect, timeout: 4000 },
  { script: SCRIPTS.captureLesson, timeout: 7000 },
  { script: SCRIPTS.updateState, timeout: 3000, always: true }
];
const STOP_BUDGET_MS = 25000;

function parsePayload(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizePayload(payload, eventName) {
  const session = String(payload.session_id || payload.sessionId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160) || 'unknown';
  const tool = payload.toolUse || payload.tool || {};
  const toolName = payload.tool_name || payload.toolName || tool.name || '';
  const toolInput = payload.tool_input || payload.toolInput || tool.input || {};
  return {
    ...payload,
    session_id: session,
    sessionId: session,
    hook_event_name: eventName,
    hookEventName: eventName,
    tool_name: toolName,
    tool_input: toolInput,
    toolUse: { ...tool, name: toolName, input: toolInput }
  };
}

function childEnv() {
  return {
    ...process.env,
    CLAUDE_BRAIN_DIR: BRAIN_DIR,
    CLAUDE_BRAIN_RUNTIME_DIR: ROOT,
    CLAUDE_BRAIN_HOST: 'claude-code',
    BRAIN_DIR
  };
}

function runScript(script, raw, timeout = 12000) {
  try {
    return spawnSync(process.execPath, [script], {
      input: raw,
      encoding: 'utf8',
      env: childEnv(),
      timeout,
      maxBuffer: 2 * 1024 * 1024
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

function runBudgeted(script, raw, timeout) {
  return timeout > 0 ? runScript(script, raw, timeout) : null;
}

function parsedOutput(result) {
  const text = String(result && result.stdout || '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function additionalContext(result) {
  const output = parsedOutput(result);
  return output && (
    output.additionalContext ||
    output.hookSpecificOutput?.additionalContext
  ) || '';
}

function routeUserPrompt(payload) {
  const raw = JSON.stringify(normalizePayload(payload, 'UserPromptSubmit'));
  const remaining = deadlineBudget(17500);
  const contexts = [
    additionalContext(runBudgeted(
      SCRIPTS.injectContext,
      raw,
      remaining(12000, 5000)
    )),
    additionalContext(runBudgeted(SCRIPTS.injectProtocol, raw, remaining(5000)))
  ].filter(Boolean);
  if (contexts.length === 0) return;
  process.stdout.write(JSON.stringify({
    decision: 'approve',
    additionalContext: contexts.join('\n\n')
  }));
}

function routeTool(payload, failure) {
  const eventName = failure ? 'PostToolUseFailure' : 'PostToolUse';
  const raw = JSON.stringify(normalizePayload(payload, eventName));
  const remaining = deadlineBudget(8000);
  runBudgeted(
    SCRIPTS.trackBehavior,
    raw,
    remaining(3500, failure ? 0 : 3500)
  );
  if (failure) return;
  const smell = parsedOutput(runBudgeted(SCRIPTS.smellCheck, raw, remaining(3500)));
  if (smell) process.stdout.write(JSON.stringify(smell));
}

function routeStop(payload) {
  const raw = JSON.stringify(normalizePayload(payload, 'Stop'));
  const remaining = deadlineBudget(STOP_BUDGET_MS);
  let relay = null;
  try {
    for (const handler of STOP_HANDLERS.filter(item => !item.always)) {
      const timeout = remaining(handler.timeout, 3500);
      if (timeout <= 0) break;
      const result = runScript(handler.script, raw, timeout);
      if (handler.relay) relay = parsedOutput(result);
    }
  } finally {
    const finalHandler = STOP_HANDLERS.find(item => item.always);
    const timeout = finalHandler && remaining(finalHandler.timeout);
    if (finalHandler && timeout > 0) runScript(finalHandler.script, raw, timeout);
  }
  if (relay && Object.keys(relay).length > 0) {
    process.stdout.write(JSON.stringify(relay));
  }
}

function dispatch(raw) {
  const payload = parsePayload(raw);
  if (MODE === 'user-prompt') return routeUserPrompt(payload);
  if (MODE === 'tool-success') return routeTool(payload, false);
  if (MODE === 'tool-failure') return routeTool(payload, true);
  if (MODE === 'stop') return routeStop(payload);
}

function readOnce() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (raw += chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      dispatch(raw);
    } catch {
      // Hooks are advisory and must never block Claude Code.
    }
  });
}

if (require.main === module) readOnce();

module.exports = {
  SCRIPTS,
  STOP_BUDGET_MS,
  STOP_HANDLERS,
  additionalContext,
  deadlineBudget,
  normalizePayload,
  parsePayload,
  runBudgeted
};
