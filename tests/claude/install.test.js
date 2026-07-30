'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const INSTALL = path.join(ROOT, 'install-hooks.sh');

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function hookCommands(config, event) {
  return (config.hooks?.[event] || [])
    .flatMap(group => group.hooks || [])
    .map(hook => hook.command)
    .filter(Boolean);
}

test('Claude fresh install bootstraps data, preserves settings, and is idempotent', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin claude install '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home with spaces');
  const brain = path.join(base, 'brain data with spaces');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'node /tmp/unrelated.js' }]
      }]
    },
    preservedSetting: true
  }), { mode: 0o600 });

  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_BRAIN_DIR: brain,
    CLAUDE_SETTINGS_PATH: settings
  };
  const first = spawnSync('bash', [INSTALL], { env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstSettings = fs.readFileSync(settings, 'utf8');
  const firstBackups = fs.readdirSync(path.dirname(settings))
    .filter(name => name.startsWith('settings.json.bak-pawin-brain-'));
  const second = spawnSync('bash', [INSTALL], { env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(settings, 'utf8'), firstSettings);
  assert.deepEqual(
    fs.readdirSync(path.dirname(settings))
      .filter(name => name.startsWith('settings.json.bak-pawin-brain-')),
    firstBackups,
    'idempotent install must not create another backup'
  );

  for (const relative of [
    'IDENTITY.md',
    'STATE.md',
    'config.json',
    'lessons/INDEX.json',
    'memory/MEMORY.md',
    'v6/config.json'
  ]) {
    const file = path.join(brain, relative);
    assert.ok(fs.existsSync(file), `missing seed: ${relative}`);
    assert.equal(mode(file), 0o600, `unsafe seed mode: ${relative}`);
  }
  assert.equal(mode(brain), 0o700);
  for (const relative of [
    'lessons',
    'state',
    'memory',
    'diary',
    'v2',
    'v2/data',
    'v3',
    'v4',
    'v5',
    'v5/ingested',
    'v6',
    'v6/state',
    'v6/loop-worklog',
    'qmd',
    'qmd/index'
  ]) {
    assert.equal(mode(path.join(brain, relative)), 0o700, `unsafe directory mode: ${relative}`);
  }
  assert.equal(mode(settings), 0o600);

  const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(config.preservedSetting, true);
  assert.match(JSON.stringify(config), /unrelated\.js/);
  for (const event of [
    'UserPromptSubmit',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop'
  ]) {
    assert.ok(Array.isArray(config.hooks[event]), `missing ${event}`);
  }
  for (const [event, modeName] of [
    ['UserPromptSubmit', 'user-prompt'],
    ['PostToolUse', 'tool-success'],
    ['PostToolUseFailure', 'tool-failure'],
    ['Stop', 'stop']
  ]) {
    const owned = hookCommands(config, event)
      .filter(command => command.includes("PAWIN_BRAIN_CLAUDE_HOOK='1'"));
    assert.equal(owned.length, 1, `expected one owned ${event} hook`);
    assert.match(owned[0], /scripts\/claude-hook-router\.js/);
    assert.match(owned[0], new RegExp(`'${modeName}'$`));
    assert.match(owned[0], /CLAUDE_BRAIN_DIR='/);
    assert.doesNotMatch(owned[0], new RegExp(`${brain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts`));
  }

  const injectCommand = hookCommands(config, 'UserPromptSubmit')
    .find(command => /claude-hook-router\.js/.test(command));
  const smoke = spawnSync('/bin/sh', ['-c', injectCommand], {
    env,
    input: JSON.stringify({
      session_id: 'claude-install-smoke',
      prompt: '如何优化一个本地记忆功能'
    }),
    encoding: 'utf8'
  });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.match(smoke.stdout, /brain-context/);
  assert.match(smoke.stdout, /honest-loop-protocol/);
});

test('Claude installer creates a missing settings file safely', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brain = path.join(home, 'brain');
  const settings = path.join(home, '.claude', 'settings.json');
  const result = spawnSync('bash', [INSTALL], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: brain,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(settings, 'utf8')));
});

test('Claude installer rejects a physical Brain alias to HOME before writing data or settings', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-home-alias-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'physical-home');
  fs.mkdirSync(home);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(base, alias, 'dir');
  const settings = path.join(home, '.claude', 'settings.json');
  const result = spawnSync('bash', [INSTALL], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: path.join(alias, 'physical-home'),
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe CLAUDE_BRAIN_DIR/i);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(fs.existsSync(settings), false);
});

test('legacy clone-as-runtime layout remains installable behind runtime ignores', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-legacy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source-and-data');
  fs.cpSync(ROOT, source, {
    recursive: true,
    filter: entry => !entry.includes(`${path.sep}.git${path.sep}`) &&
      path.basename(entry) !== '.git'
  });
  const home = path.join(base, 'home');
  const settings = path.join(home, '.claude', 'settings.json');
  const result = spawnSync('bash', [path.join(source, 'install-hooks.sh')], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: source,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const relative of [
    'IDENTITY.md',
    'STATE.md',
    'lessons/INDEX.json',
    'memory/MEMORY.md'
  ]) {
    assert.ok(fs.existsSync(path.join(source, relative)), `missing legacy seed: ${relative}`);
  }
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(settings, 'utf8')));
});

test('uninstall is a byte-for-byte no-op when Pawin hooks are absent', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-uninstall-noop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = '{"preserved":true,"hooks":{"Stop":[]}}\n';
  fs.writeFileSync(settings, original, { mode: 0o600 });
  const result = spawnSync('bash', [INSTALL, '--uninstall'], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
});

test('Claude uninstall removes only owned hooks, preserves unrelated settings, and is idempotent', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin claude uninstall '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home with spaces');
  const brain = path.join(base, 'brain data');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      Stop: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'node /tmp/keep-me.js' }]
      }]
    },
    preservedSetting: { nested: true }
  }), { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_BRAIN_DIR: brain,
    CLAUDE_SETTINGS_PATH: settings
  };

  assert.equal(spawnSync('bash', [INSTALL], { env, encoding: 'utf8' }).status, 0);
  const removed = spawnSync('bash', [INSTALL, '--uninstall'], { env, encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  const afterFirst = fs.readFileSync(settings, 'utf8');
  const config = JSON.parse(afterFirst);
  assert.deepEqual(config.preservedSetting, { nested: true });
  assert.match(JSON.stringify(config), /keep-me\.js/);
  assert.doesNotMatch(JSON.stringify(config), /PAWIN_BRAIN_CLAUDE_HOOK/);

  const repeated = spawnSync('bash', [INSTALL, '--uninstall'], { env, encoding: 'utf8' });
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(fs.readFileSync(settings, 'utf8'), afterFirst);
});

test('Claude installer refuses malformed settings without overwriting them', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-invalid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ invalid json', { mode: 0o600 });
  const before = fs.readFileSync(settings, 'utf8');
  const result = spawnSync('bash', [INSTALL], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: path.join(home, 'brain'),
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
});

test('Claude uninstall is a no-op when settings do not exist', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-no-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  const result = spawnSync('bash', [INSTALL, '--uninstall'], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(settings), false);
});

test('Claude uninstall does not remove an unrelated router with the same basename', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-router-name-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      Stop: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: "node '/tmp/another-product/claude-hook-router.js' stop"
        }]
      }]
    }
  }), { mode: 0o600 });
  const result = spawnSync('bash', [INSTALL, '--uninstall'], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(settings, 'utf8'), /another-product/);
});

test('Claude upgrade removes the historical source smell hook but preserves same-name hooks elsewhere', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-claude-legacy-smell-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const historical = path.join(ROOT, 'scripts', 'smell-check.js');
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: '',
        hooks: [
          { type: 'command', command: `node '${historical}'` },
          { type: 'command', command: "node '/tmp/another-product/smell-check.js'" }
        ]
      }]
    }
  }), { mode: 0o600 });
  const result = spawnSync('bash', [INSTALL, '--uninstall'], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_SETTINGS_PATH: settings
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const content = fs.readFileSync(settings, 'utf8');
  assert.doesNotMatch(content, new RegExp(
    historical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ));
  assert.match(content, /another-product\/smell-check\.js/);
});

test('legacy installers delegate to the complete installer instead of wiring partial hooks', () => {
  const legacyFiles = [
    path.join(ROOT, 'install.js'),
    path.join(ROOT, 'install-capture-lesson.sh'),
    path.join(ROOT, 'v3', 'install-think-loop.sh')
  ];
  for (const file of legacyFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /install-(?:claude-)?hooks/);
    assert.doesNotMatch(source, /python3\s+<<|capture-lesson\.js;\s*node/);
  }
});
