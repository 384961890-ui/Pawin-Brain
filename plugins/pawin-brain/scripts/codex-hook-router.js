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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', main);

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
    if (typeof candidate === 'string' && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function transcriptLine(role, content) {
  return JSON.stringify({ role, content, message: { role, content } });
}

function responseItemLines(file) {
  if (!file) return [];
  let rows;
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500);
  } catch {
    return [];
  }
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
  const file = path.join(
    os.tmpdir(),
    `pawin-brain-codex-${process.pid}-${Date.now()}.jsonl`
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

function routeUserPrompt(payload) {
  const adapted = normalizePayload(payload, 'UserPromptSubmit');
  const result = runScript(SCRIPTS.injectContext, JSON.stringify(adapted), 15000);
  relayUserPrompt(result && result.stdout);
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
  runScript(SCRIPTS.trackBehavior, raw);
  if (!failure) {
    const paths = patchPaths(payload);
    if (paths.length) {
      for (const filePath of paths) {
        const smellPayload = normalizePayload({
          ...payload,
          tool_name: 'Edit',
          tool_input: { file_path: filePath }
        }, 'PostToolUse');
        const smell = runScript(SCRIPTS.smellCheck, JSON.stringify(smellPayload));
        if (validJson(smell && smell.stdout)) {
          relay(smell.stdout);
          break;
        }
      }
    } else {
      const smell = runScript(SCRIPTS.smellCheck, raw);
      relay(smell && smell.stdout);
    }
  }
}

function routeStop(payload) {
  const temporary = buildTranscript(payload);
  const transcriptPath = temporary;
  const adapted = normalizePayload({
    ...payload,
    transcript_path: transcriptPath || undefined,
    transcriptPath: transcriptPath || undefined
  }, 'Stop');
  const raw = JSON.stringify(adapted);
  let finishOutput = '';

  try {
    if (transcriptPath) {
      runScript(SCRIPTS.stopAudit, raw);
      const finish = runScript(SCRIPTS.finishWork, raw);
      finishOutput = finish && finish.stdout;
      runScript(SCRIPTS.thinkDetect, raw);
      runScript(SCRIPTS.captureLesson, raw, 15000);
    }
    runScript(SCRIPTS.updateState, raw);
  } finally {
    if (temporary) {
      try { fs.unlinkSync(temporary); } catch {}
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
  }
}

module.exports = {
  buildTranscript,
  normalizePayload,
  normalizeToolName,
  patchPaths,
  sessionId,
  toolFailed,
  transcriptCandidate
};
