#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { bootstrap, BRAIN_DIR, PLUGIN_ROOT } = require('./bootstrap-runtime.js');

const MODE = process.argv[2] || '';
const RUNTIME_DIR = path.join(PLUGIN_ROOT, 'runtime');
const SCRIPTS = {
  injectContext: path.join(RUNTIME_DIR, 'scripts/inject-context.js'),
  trackBehavior: path.join(RUNTIME_DIR, 'scripts/track-behavior.js'),
  smellCheck: path.join(RUNTIME_DIR, 'v6/scripts/smell-check.js'),
  stopAudit: path.join(RUNTIME_DIR, 'v2/scripts/stop-audit.js'),
  finishWork: path.join(RUNTIME_DIR, 'v2/scripts/finish-the-work.js'),
  thinkDetect: path.join(RUNTIME_DIR, 'v3/scripts/think-detect.js'),
  captureLesson: path.join(RUNTIME_DIR, 'scripts/capture-lesson.js'),
  updateState: path.join(RUNTIME_DIR, 'scripts/update-state.js')
};
const STOP_TIMEOUTS = Object.freeze({
  stopAudit: 6000,
  finishWork: 6000,
  thinkDetect: 6000,
  captureLesson: 9000,
  updateState: 5000
});
const STOP_BUDGET_MS = 38000;
const MAX_ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;

let input = '';
if (require.main === module) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => (input += chunk));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', main);
}

function parsePayload(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function sessionId(payload) {
  const raw = payload.session_id || payload.sessionId || payload.thread_id ||
    payload.threadId || 'unknown';
  return String(raw).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown';
}

function normalizePayload(payload, eventName) {
  const toolUse = payload.toolUse || payload.tool || {};
  const rawToolName = payload.tool_name || payload.toolName || toolUse.name || '';
  const toolName = normalizeToolName(rawToolName);
  const toolInput = payload.tool_input || payload.toolInput || toolUse.input || {};
  return {
    ...payload,
    session_id: sessionId(payload),
    sessionId: sessionId(payload),
    hook_event_name: eventName || payload.hook_event_name || payload.hookEventName,
    hookEventName: eventName || payload.hookEventName || payload.hook_event_name,
    tool_name: toolName,
    tool_input: toolInput,
    toolUse: { ...toolUse, name: toolName, input: toolInput }
  };
}

function normalizeToolName(name) {
  const aliases = {
    apply_patch: 'Edit',
    exec_command: 'Bash',
    write_stdin: 'Bash',
    view_image: 'Read'
  };
  return aliases[name] || name || '';
}

function toolFailed(payload) {
  const response = payload.tool_response ?? payload.toolResponse ?? payload.response;
  if (!response || typeof response !== 'object') return false;
  if (response.is_error === true || response.isError === true || response.success === false) {
    return true;
  }
  if (typeof response.exit_code === 'number' && response.exit_code !== 0) return true;
  if (typeof response.exitCode === 'number' && response.exitCode !== 0) return true;
  return ['error', 'failed', 'failure'].includes(String(response.status || '').toLowerCase());
}

function childEnv() {
  return {
    ...process.env,
    CLAUDE_BRAIN_HOST: 'codex',
    CLAUDE_BRAIN_DIR: BRAIN_DIR,
    CLAUDE_BRAIN_RUNTIME_DIR: RUNTIME_DIR
  };
}

function runScript(script, stdin, timeout = 12000) {
  try {
    return spawnSync(process.execPath, [script], {
      input: stdin,
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

function runBudgeted(script, stdin, timeout) {
  return timeout > 0 ? runScript(script, stdin, timeout) : null;
}

function childFailure(result) {
  if (!result) return 'spawn_failed';
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') return 'timeout';
  if (result.error) return 'spawn_failed';
  if (typeof result.status === 'number' && result.status !== 0) return 'nonzero_exit';
  if (result.status === null && result.signal) return 'terminated';
  return '';
}

function reportStepFailure(step, result) {
  const reason = childFailure(result);
  if (!reason) return false;
  process.stderr.write(`pawin-brain: ${step} failed (${reason})\n`);
  return true;
}

function emitContext(eventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  }));
}

function emitHookFailure(mode, reason) {
  const eventName = mode === 'session-start' ? 'SessionStart' :
    mode === 'user-prompt' ? 'UserPromptSubmit' : '';
  const message = `> ⚠️ Pawin Brain 未完成本轮注入（${reason}）` +
    '。本轮会继续运行，但不会假装记忆已加载；请运行 Brain doctor。';
  if (eventName) emitContext(eventName, message);
  else process.stderr.write(`pawin-brain: ${reason}\n`);
}

function validJson(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  try {
    JSON.parse(value);
    return value;
  } catch {
    return '';
  }
}

function relay(text) {
  const output = validJson(text);
  if (output) process.stdout.write(output);
}

function relayUserPrompt(text) {
  const output = validJson(text);
  if (!output) return;
  const parsed = JSON.parse(output);
  const additionalContext = parsed.additionalContext ||
    parsed.hookSpecificOutput?.additionalContext || '';
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext
    }
  }));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && (
      block.type === 'text' ||
      block.type === 'input_text' ||
      block.type === 'output_text' ||
      typeof block.text === 'string'
    ))
    .map(block => block.text || block.input_text || block.output_text || '')
    .filter(Boolean)
    .join('\n');
}

function transcriptCandidate(payload) {
  for (const candidate of [
    payload.transcript_path,
    payload.transcriptPath,
    payload.rollout_path,
    payload.rolloutPath
  ]) {
    if (typeof candidate !== 'string') continue;
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { stat = null; }
    if (stat && stat.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  return null;
}

function transcriptLine(role, content) {
  return JSON.stringify({ role, content, message: { role, content } });
}

function readBoundedTail(file, maxBytes = MAX_ROLLOUT_TAIL_BYTES) {
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

function responseItemLines(file) {
  const rows = readBoundedTail(file).split('\n').filter(Boolean).slice(-500);
  const lines = [];
  for (const row of rows) {
    let record;
    try { record = JSON.parse(row); } catch { continue; }
    if (record.type !== 'response_item') continue;
    const item = record.payload || {};
    if (item.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      const text = textFromContent(item.content);
      if (text) lines.push(transcriptLine(item.role, [{ type: 'text', text }]));
      continue;
    }
    if (
      item.type === 'function_call' ||
      item.type === 'custom_tool_call' ||
      item.type === 'tool_search_call'
    ) {
      lines.push(transcriptLine('assistant', [{
        type: 'tool_use',
        name: item.name || item.type
      }]));
    }
  }
  return lines;
}

function createPrivateTranscript(prefix, lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'transcript.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    fs.chmodSync(file, 0o600);
    return { directory, file };
  } catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function buildTranscript(payload) {
  const lines = [];
  const source = transcriptCandidate(payload);
  lines.push(...responseItemLines(source));
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const item of messages.slice(-100)) {
    const message = item.message || item;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textFromContent(message.content);
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text }];
    lines.push(transcriptLine(role, content));
  }

  if (lines.length === 0) {
    const userText = payload.prompt || payload.user_prompt || payload.userPrompt || '';
    const assistantText = payload.responseText || payload.response_text ||
      payload.last_assistant_message || payload.lastAssistantMessage ||
      textFromContent(payload.response || payload.assistant_message);
    if (userText) {
      const content = [{ type: 'text', text: String(userText) }];
      lines.push(transcriptLine('user', content));
    }
    if (assistantText) {
      const content = [{ type: 'text', text: String(assistantText) }];
      lines.push(transcriptLine('assistant', content));
    }
  }

  if (lines.length === 0) return null;
  return createPrivateTranscript('pawin-brain-codex-', lines);
}

function routeUserPrompt(payload) {
  const adapted = normalizePayload(payload, 'UserPromptSubmit');
  const remaining = deadlineBudget(12500);
  const result = runBudgeted(
    SCRIPTS.injectContext,
    JSON.stringify(adapted),
    remaining(12000)
  );
  if (reportStepFailure('inject-context', result)) {
    emitHookFailure('user-prompt', 'context_injection_failed');
    return;
  }
  const output = validJson(result && result.stdout);
  if (!output && String(adapted.prompt || adapted.user_prompt || '').trim()) {
    emitHookFailure('user-prompt', 'context_output_invalid');
    return;
  }
  relayUserPrompt(output);
}

function patchPaths(payload) {
  const rawName = payload.tool_name || payload.toolName || payload.toolUse?.name || '';
  if (rawName !== 'apply_patch') return [];
  const command = payload.tool_input?.command || payload.toolInput?.command ||
    payload.toolUse?.input?.command || '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const paths = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match;
  while ((match = pattern.exec(command))) {
    const candidate = match[1].trim();
    paths.push(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
  }
  return [...new Set(paths)];
}

function routeTool(payload) {
  const failure = toolFailed(payload);
  const eventName = failure ? 'PostToolUseFailure' : 'PostToolUse';
  const adapted = normalizePayload(payload, eventName);
  const raw = JSON.stringify(adapted);
  const remaining = deadlineBudget(12000);
  reportStepFailure(
    'track-behavior',
    runBudgeted(SCRIPTS.trackBehavior, raw, remaining(3500, 7000))
  );
  if (!failure) {
    const paths = patchPaths(payload);
    if (paths.length) {
      for (const filePath of paths) {
        const timeout = remaining(3500);
        if (timeout <= 0) break;
        const smellPayload = normalizePayload({
          ...payload,
          tool_name: 'Edit',
          tool_input: { file_path: filePath }
        }, 'PostToolUse');
        const smell = runBudgeted(
          SCRIPTS.smellCheck,
          JSON.stringify(smellPayload),
          timeout
        );
        reportStepFailure('smell-check', smell);
        if (validJson(smell && smell.stdout)) {
          relay(smell.stdout);
          break;
        }
      }
    } else {
      const smell = runBudgeted(SCRIPTS.smellCheck, raw, remaining(3500));
      reportStepFailure('smell-check', smell);
      relay(smell && smell.stdout);
    }
  }
}

function routeStop(payload) {
  const remaining = deadlineBudget(STOP_BUDGET_MS);
  const temporary = buildTranscript(payload);
  const transcriptPath = temporary && temporary.file;
  const adapted = normalizePayload({
    ...payload,
    transcript_path: transcriptPath || undefined,
    transcriptPath: transcriptPath || undefined
  }, 'Stop');
  const raw = JSON.stringify(adapted);
  let finishOutput = '';

  try {
    if (transcriptPath) {
      reportStepFailure(
        'stop-audit',
        runBudgeted(
          SCRIPTS.stopAudit,
          raw,
          remaining(STOP_TIMEOUTS.stopAudit, STOP_TIMEOUTS.updateState + 1000)
        )
      );
      const finish = runBudgeted(
        SCRIPTS.finishWork,
        raw,
        remaining(STOP_TIMEOUTS.finishWork, STOP_TIMEOUTS.updateState + 1000)
      );
      reportStepFailure('finish-the-work', finish);
      finishOutput = finish && finish.stdout;
      reportStepFailure(
        'think-detect',
        runBudgeted(
          SCRIPTS.thinkDetect,
          raw,
          remaining(STOP_TIMEOUTS.thinkDetect, STOP_TIMEOUTS.updateState + 1000)
        )
      );
      reportStepFailure(
        'capture-lesson',
        runBudgeted(
          SCRIPTS.captureLesson,
          raw,
          remaining(STOP_TIMEOUTS.captureLesson, STOP_TIMEOUTS.updateState + 1000)
        )
      );
    }
    reportStepFailure(
      'update-state',
      runBudgeted(SCRIPTS.updateState, raw, remaining(STOP_TIMEOUTS.updateState))
    );
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary.directory, { recursive: true, force: true }); } catch {}
    }
  }
  relay(finishOutput);
}

function main() {
  try {
    bootstrap();
    const payload = parsePayload(input);
    if (MODE === 'session-start') return;
    if (MODE === 'user-prompt') return routeUserPrompt(payload);
    if (MODE === 'tool' || MODE === 'tool-success' || MODE === 'tool-failure') {
      if (MODE === 'tool-failure') {
        payload.tool_response = { ...(payload.tool_response || {}), success: false };
      }
      return routeTool(payload);
    }
    if (MODE === 'stop') return routeStop(payload);
  } catch {
    // Hooks are advisory. Brain must never block Codex because Brain itself failed.
    emitHookFailure(MODE, 'bootstrap_or_router_failed');
  }
}

module.exports = {
  buildTranscript,
  childFailure,
  deadlineBudget,
  normalizePayload,
  normalizeToolName,
  patchPaths,
  readBoundedTail,
  responseItemLines,
  sessionId,
  STOP_BUDGET_MS,
  STOP_TIMEOUTS,
  toolFailed,
  transcriptCandidate,
  runBudgeted
};
