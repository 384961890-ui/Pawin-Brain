'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const PLUGIN = path.join(ROOT, 'plugins/pawin-brain');
const ROUTER = path.join(PLUGIN, 'scripts/codex-hook-router.js');

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runRouter(mode, payload, home) {
  return spawnSync(process.execPath, [ROUTER, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: path.join(home, '.claude-brain'),
      PLUGIN_ROOT: PLUGIN,
      CLAUDE_PLUGIN_ROOT: PLUGIN
    },
    timeout: 30000
  });
}

test('marketplace and plugin expose the Codex v8.3 host', () => {
  const marketplace = json(path.join(ROOT, '.agents/plugins/marketplace.json'));
  const manifest = json(path.join(PLUGIN, '.codex-plugin/plugin.json'));
  const hooks = json(path.join(PLUGIN, 'hooks/hooks.json')).hooks;
  assert.equal(marketplace.name, 'pawin-brain');
  assert.equal(marketplace.plugins[0].source.path, './plugins/pawin-brain');
  assert.equal(manifest.version, '8.3.0');
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'Stop'
  ]) assert.ok(hooks[event], `missing ${event}`);
});

test('bundled runtime is byte-identical to its public v8.3 sources', () => {
  const manifest = json(path.join(PLUGIN, 'runtime-manifest.json'));
  assert.equal(manifest.baseline, 'Brain v8.3 public final');
  assert.ok(manifest.files.length > 80);
  for (const entry of manifest.files) {
    const source = path.join(ROOT, entry.path);
    const bundled = path.join(PLUGIN, 'runtime', entry.path);
    assert.equal(sha256(source), entry.sha256, `source drift: ${entry.path}`);
    assert.equal(sha256(bundled), entry.sha256, `bundle drift: ${entry.path}`);
  }
});

test('bootstrap creates generic data once and preserves user data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-brain-bootstrap-'));
  const brain = path.join(home, '.claude-brain');
  fs.mkdirSync(brain, { recursive: true });
  fs.writeFileSync(path.join(brain, 'IDENTITY.md'), '# My identity\nkeep me\n');

  const first = runRouter('session-start', {}, home);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(path.join(brain, 'IDENTITY.md'), 'utf8'), '# My identity\nkeep me\n');
  assert.ok(fs.existsSync(path.join(brain, 'lessons/INDEX.json')));
  assert.ok(fs.existsSync(path.join(brain, 'memory/MEMORY.md')));

  fs.writeFileSync(path.join(brain, 'STATE.md'), '最后更新：custom\nDO NOT OVERWRITE\n');
  const second = runRouter('session-start', {}, home);
  assert.equal(second.status, 0, second.stderr);
  assert.match(fs.readFileSync(path.join(brain, 'STATE.md'), 'utf8'), /DO NOT OVERWRITE/);
});

test('UserPromptSubmit injects Codex identity, state, and Brain context', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-brain-prompt-'));
  runRouter('session-start', {}, home);
  const brain = path.join(home, '.claude-brain');
  fs.writeFileSync(path.join(brain, 'IDENTITY.md'), '# Test identity\nRemember this voice.\n');
  const result = runRouter('user-prompt', {
    session_id: 'session-test',
    prompt: '实现一个本地记忆功能'
  }, home);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /Test identity/);
  assert.match(output.hookSpecificOutput.additionalContext, /THINK-LOOP/);
  assert.match(output.hookSpecificOutput.additionalContext, /<brain-context>/);
});

test('tool events collect v8 behavior metrics and sanitize session ids', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-brain-tools-'));
  const result = runRouter('tool', {
    sessionId: '../../unsafe/session',
    toolUse: { name: 'Write', input: { file_path: '/tmp/example.js' } }
  }, home);
  assert.equal(result.status, 0, result.stderr);
  const stateDir = path.join(home, '.claude-brain/state');
  const files = fs.readdirSync(stateDir).filter(name => name.startsWith('behavior-'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('/'));
  const state = json(path.join(stateDir, files[0]));
  assert.equal(state.first_write_step, 1);

  runRouter('tool', {
    session_id: '../../unsafe/session',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 1, status: 'failed' }
  }, home);
  const updated = json(path.join(stateDir, files[0]));
  assert.equal(updated.failure_count, 1);
  assert.equal(updated.validation_count, 1);
});

test('Codex apply_patch is counted as a write and exposes changed files to v6', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-brain-patch-'));
  const source = path.join(home, 'sample.js');
  fs.writeFileSync(source, 'const value = 1;\n');
  const result = runRouter('tool', {
    session_id: 'patch-test',
    cwd: home,
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: sample.js\n*** End Patch\n' },
    tool_response: { status: 'success' }
  }, home);
  assert.equal(result.status, 0, result.stderr);
  const state = json(path.join(home, '.claude-brain/state/behavior-patch-test.json'));
  assert.equal(state.first_write_step, 1);
});

test('Stop uses Codex transcript fields and updates durable state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-brain-stop-'));
  runRouter('session-start', {}, home);
  const rollout = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '检查一下' }]
      }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '我已经完成了这项修复。' }]
      }
    })
  ].join('\n'));
  const result = runRouter('stop', {
    sessionId: 'stop-test',
    transcript_path: rollout,
    last_assistant_message: '我已经完成了这项修复。'
  }, home);
  assert.equal(result.status, 0, result.stderr);
  const state = fs.readFileSync(path.join(home, '.claude-brain/STATE.md'), 'utf8');
  assert.doesNotMatch(state, /first run/);
});

test('public additions contain no local identity or private v9 paths', () => {
  const forbidden = [
    new RegExp(['Users', 'a1234'].join('/'), 'i'),
    new RegExp(['wang', 'tian', 'rui'].join(''), 'i'),
    new RegExp(['PAWMI', 'GROWING', 'UP'].join('-'), 'i'),
    new RegExp(['\\.claude-brain', 'v9'].join('/'), 'i'),
    new RegExp(['private', 'brain'].join('[-_ ]?'), 'i')
  ];
  const roots = [
    path.join(ROOT, '.agents'),
    path.join(ROOT, 'plugins/pawin-brain'),
    path.join(ROOT, 'docs/plans'),
    path.join(ROOT, 'tests/codex'),
    path.join(ROOT, 'scripts/build-codex-runtime.js')
  ];
  const files = [];
  function walk(target) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return files.push(target);
    for (const name of fs.readdirSync(target)) walk(path.join(target, name));
  }
  roots.forEach(walk);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(content, pattern, file);
  }
});
