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
const BOOTSTRAP = path.join(PLUGIN, 'scripts/bootstrap-runtime.js');

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function temporaryHome(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
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

test('marketplace and plugin expose the Codex v8.3.1 host', () => {
  const marketplace = json(path.join(ROOT, '.agents/plugins/marketplace.json'));
  const manifest = json(path.join(PLUGIN, '.codex-plugin/plugin.json'));
  const hooks = json(path.join(PLUGIN, 'hooks/hooks.json')).hooks;
  assert.equal(marketplace.name, 'pawin-brain');
  assert.equal(marketplace.plugins[0].source.path, './plugins/pawin-brain');
  assert.equal(manifest.version, '8.3.1');
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PostToolUse',
    'Stop'
  ]) assert.ok(hooks[event], `missing ${event}`);
});

test('every bootstrap seed is present in the published plugin', () => {
  for (const file of [
    'IDENTITY.md',
    'STATE.md',
    'config.json',
    'lessons-index.json',
    'memory-index.md',
    'v6-config.json'
  ]) {
    assert.ok(
      fs.existsSync(path.join(PLUGIN, 'templates', file)),
      `missing published bootstrap seed: ${file}`
    );
  }
});

test('the published config seed is not ignored by git', () => {
  const result = spawnSync('git', [
    'check-ignore', '-q', 'plugins/pawin-brain/templates/config.json'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.status, 1, result.stderr);
});

test('bundled runtime is byte-identical to its public v8.3.1 sources', () => {
  const manifest = json(path.join(PLUGIN, 'runtime-manifest.json'));
  assert.equal(manifest.baseline, 'Brain v8.3.1 public hardening');
  assert.ok(manifest.files.length > 80);
  for (const entry of manifest.files) {
    const source = path.join(ROOT, entry.path);
    const bundled = path.join(PLUGIN, 'runtime', entry.path);
    assert.equal(sha256(source), entry.sha256, `source drift: ${entry.path}`);
    assert.equal(sha256(bundled), entry.sha256, `bundle drift: ${entry.path}`);
  }
});

test('bootstrap creates generic data once and preserves user data', t => {
  const home = temporaryHome(t, 'pawin-brain-bootstrap-');
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

test('bootstrap rejects a physical alias to HOME but allows a legitimate symlinked ancestor', t => {
  const sandbox = temporaryHome(t, 'pawin-brain-physical-path-');
  const home = path.join(sandbox, 'physical-home');
  fs.mkdirSync(home);
  const alias = path.join(sandbox, 'alias');
  fs.symlinkSync(sandbox, alias, 'dir');
  const aliasedHome = path.join(alias, 'physical-home');

  const rejected = spawnSync(process.execPath, [BOOTSTRAP], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: aliasedHome
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unsafe Brain directory/i);
  assert.deepEqual(fs.readdirSync(home), []);

  const physicalParent = path.join(sandbox, 'physical-parent');
  const linkedParent = path.join(sandbox, 'linked-parent');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(physicalParent, linkedParent, 'dir');
  const allowedBrain = path.join(linkedParent, 'brain');
  const allowed = spawnSync(process.execPath, [BOOTSTRAP], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: allowedBrain
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  assert.ok(fs.existsSync(path.join(physicalParent, 'brain', 'IDENTITY.md')));
});

test('UserPromptSubmit injects Codex identity, state, and Brain context', t => {
  const home = temporaryHome(t, 'pawin-brain-prompt-');
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

test('Codex hook stays fail-open but makes bootstrap failures visible', t => {
  const home = temporaryHome(t, 'pawin-brain-failure-');
  const result = spawnSync(process.execPath, [ROUTER, 'user-prompt'], {
    input: JSON.stringify({
      session_id: 'failure-test',
      prompt: '实现一个本地记忆功能'
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: home,
      PLUGIN_ROOT: PLUGIN,
      CLAUDE_PLUGIN_ROOT: PLUGIN
    },
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /不会假装记忆已加载/);
  assert.equal(fs.existsSync(path.join(home, 'IDENTITY.md')), false);
});

test('Codex hook exposes a dangling seed symlink as a bootstrap failure', t => {
  const home = temporaryHome(t, 'pawin-brain-dangling-seed-');
  const brain = path.join(home, '.claude-brain');
  fs.mkdirSync(brain);
  const external = path.join(home, 'missing-external-identity.md');
  fs.symlinkSync(external, path.join(brain, 'IDENTITY.md'));

  const result = runRouter('user-prompt', {
    session_id: 'dangling-seed',
    prompt: '检查 Brain'
  }, home);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /不会假装记忆已加载/);
  assert.equal(fs.lstatSync(path.join(brain, 'IDENTITY.md')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(external), false);
});

test('tool events collect v8 behavior metrics and sanitize session ids', t => {
  const home = temporaryHome(t, 'pawin-brain-tools-');
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

test('Codex apply_patch is counted as a write and exposes changed files to v6', t => {
  const home = temporaryHome(t, 'pawin-brain-patch-');
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

test('Stop uses Codex transcript fields and updates durable state', t => {
  const home = temporaryHome(t, 'pawin-brain-stop-');
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

test('Codex transcript conversion reads only a bounded regular-file tail', t => {
  const sandbox = temporaryHome(t, 'pawin-brain-rollout-tail-');
  const rollout = path.join(sandbox, 'rollout.jsonl');
  const old = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'old row must be outside the tail' }]
    }
  });
  const recent = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'recent bounded row' }]
    }
  });
  const descriptor = fs.openSync(rollout, 'w');
  try {
    fs.writeSync(descriptor, `${old}\n`);
    fs.writeSync(descriptor, Buffer.alloc(5 * 1024 * 1024, 0x78));
    fs.writeSync(descriptor, `\n${recent}\n`);
  } finally {
    fs.closeSync(descriptor);
  }

  const router = require(ROUTER);
  const lines = router.responseItemLines(rollout);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /recent bounded row/);
  assert.doesNotMatch(lines[0], /old row/);

  const external = path.join(sandbox, 'external.jsonl');
  fs.writeFileSync(external, `${recent}\n`);
  const link = path.join(sandbox, 'rollout-link.jsonl');
  fs.symlinkSync(external, link);
  assert.equal(router.transcriptCandidate({ transcript_path: link }), null);
  assert.deepEqual(router.responseItemLines(link), []);
});

test('Codex transcript temp files live in a private unique directory', t => {
  const router = require(ROUTER);
  const temporary = router.buildTranscript({
    messages: [{ role: 'user', content: 'private message' }]
  });
  t.after(() => fs.rmSync(temporary.directory, { recursive: true, force: true }));
  assert.equal(fs.statSync(temporary.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(temporary.file).mode & 0o777, 0o600);
  assert.equal(path.dirname(temporary.file), temporary.directory);
  assert.match(path.basename(temporary.directory), /^pawin-brain-codex-/);
});

test('public additions contain no private v9 paths or injected release-denylist terms', () => {
  const injectedTerms = String(process.env.PAWIN_RELEASE_DENYLIST || '')
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
  const forbidden = [
    new RegExp(['\\.claude-brain', 'v9'].join('/'), 'i'),
    new RegExp(['private', 'brain'].join('[-_ ]?'), 'i'),
    ...injectedTerms.map(term => new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
    ))
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
