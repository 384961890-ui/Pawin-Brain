#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const home = os.homedir();
const settingsPath = path.resolve(
  process.env.CLAUDE_SETTINGS_PATH || path.join(home, '.claude', 'settings.json')
);
const brainDir = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.join(home, '.claude-brain')
);
const nodeBin = process.env.CLAUDE_BRAIN_NODE || process.execPath;
const router = path.join(ROOT, 'scripts', 'claude-hook-router.js');
const HISTORICAL_SOURCE_HOOKS = new Set([
  path.join(ROOT, 'scripts', 'smell-check.js')
]);
const bootstrapScript = path.join(
  ROOT,
  'plugins',
  'pawin-brain',
  'scripts',
  'bootstrap-runtime.js'
);
const OWNED_MARKER = "PAWIN_BRAIN_CLAUDE_HOOK='1'";
const EVENTS = ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const REQUIRED_DIRS = [
  '',
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
];
const REQUIRED_SEEDS = [
  'IDENTITY.md',
  'STATE.md',
  'config.json',
  'lessons/INDEX.json',
  'memory/MEMORY.md',
  'v6/config.json'
];

function fail(message) {
  process.stderr.write(`Pawin-Brain Claude installer: ${message}\n`);
  process.exit(1);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function hookCommand(mode) {
  const environment = [
    OWNED_MARKER,
    `CLAUDE_BRAIN_DIR=${shellQuote(brainDir)}`,
    `CLAUDE_BRAIN_RUNTIME_DIR=${shellQuote(ROOT)}`,
    `CLAUDE_BRAIN_HOST=${shellQuote('claude-code')}`
  ];
  return [
    ...environment,
    shellQuote(nodeBin),
    shellQuote(router),
    shellQuote(mode)
  ].join(' ');
}

function readSettings() {
  if (!fs.existsSync(settingsPath)) return { existed: false, raw: '', config: {} };
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    fail(`cannot parse ${settingsPath}: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail(`${settingsPath} must contain a JSON object`);
  }
  return { existed: true, raw, config };
}

function isOwnedCommand(command) {
  if (typeof command !== 'string') return false;
  if (command.includes(OWNED_MARKER)) return true;
  if (command.includes(router)) return true;
  if ([...HISTORICAL_SOURCE_HOOKS].some(target => command.includes(target))) return true;
  if (!command.includes('.claude-brain')) return false;
  return [
    '/scripts/inject-context.js',
    '/v2/scripts/inject-protocol-v2.js',
    '/scripts/track-behavior.js',
    '/scripts/smell-check.js',
    '/v6/scripts/smell-check.js',
    '/v2/scripts/stop-audit.js',
    '/v2/scripts/finish-the-work.js',
    '/v3/scripts/think-detect.js',
    '/scripts/capture-lesson.js',
    '/scripts/update-state.js'
  ].some(suffix => command.includes(suffix));
}

function removeOwnedHooks(config) {
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  let removed = 0;
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event].flatMap(group => {
      if (!group || typeof group !== 'object') return [group];
      if (!Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter(hook => !isOwnedCommand(hook && hook.command));
      removed += group.hooks.length - remaining.length;
      return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
    });
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  return removed;
}

function addHooks(config) {
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? config.hooks
    : (config.hooks = {});
  const definitions = {
    UserPromptSubmit: ['user-prompt', 20],
    PostToolUse: ['tool-success', 10],
    PostToolUseFailure: ['tool-failure', 10],
    Stop: ['stop', 30]
  };
  for (const [event, [mode, timeout]] of Object.entries(definitions)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
    groups.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: hookCommand(mode),
        timeout
      }]
    });
  }
}

function assertSafeLocations() {
  const root = path.parse(brainDir).root;
  if (!brainDir || brainDir === root || brainDir === home) {
    fail(`unsafe CLAUDE_BRAIN_DIR: ${brainDir}`);
  }
  if (!fs.existsSync(bootstrapScript)) {
    fail(`missing plugin bootstrap: ${bootstrapScript}`);
  }
  let assertSafeBrainDir;
  try {
    ({ assertSafeBrainDir } = require(bootstrapScript));
    assertSafeBrainDir(brainDir);
  } catch (error) {
    fail(`unsafe CLAUDE_BRAIN_DIR: ${error.message}`);
  }
}

function bootstrap() {
  assertSafeLocations();
  const result = spawnSync(nodeBin, [bootstrapScript, '--json'], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CLAUDE_BRAIN_DIR: brainDir }
  });
  if (result.error) fail(`plugin bootstrap failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`plugin bootstrap failed with status ${result.status}: ${result.stderr || ''}`);
  }
  for (const relative of REQUIRED_DIRS) {
    const directory = path.join(brainDir, relative);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      fail(`plugin bootstrap omitted directory: ${relative || '.'}`);
    }
    fs.chmodSync(directory, 0o700);
  }
  for (const relative of REQUIRED_SEEDS) {
    const file = path.join(brainDir, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      fail(`plugin bootstrap omitted seed: ${relative}`);
    }
    fs.chmodSync(file, 0o600);
  }
}

function smokeCheck() {
  const result = spawnSync(nodeBin, [router, 'user-prompt'], {
    input: JSON.stringify({
      session_id: 'claude-installer-smoke',
      prompt: '如何优化一个本地记忆功能'
    }),
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      CLAUDE_BRAIN_DIR: brainDir,
      CLAUDE_BRAIN_RUNTIME_DIR: ROOT,
      CLAUDE_BRAIN_HOST: 'claude-code',
      BRAIN_DRY_RUN: '1'
    }
  });
  if (result.error) fail(`runtime smoke check failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`runtime smoke check failed with status ${result.status}: ${result.stderr || ''}`);
  }
  let output;
  try {
    output = JSON.parse((result.stdout || '').trim());
  } catch (error) {
    fail(`runtime smoke check returned invalid JSON: ${error.message}`);
  }
  const context = output && (
    output.additionalContext ||
    output.hookSpecificOutput?.additionalContext
  );
  if (
    typeof context !== 'string' ||
    !context.includes('<brain-context>') ||
    !context.includes('<honest-loop-protocol>')
  ) {
    fail('runtime smoke check did not return Brain context and protocol');
  }
}

function backupAndWrite(previous, next) {
  if (previous.raw === next && previous.existed) {
    fs.chmodSync(settingsPath, 0o600);
    return false;
  }
  const parent = path.dirname(settingsPath);
  const parentExisted = fs.existsSync(parent);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentExisted) fs.chmodSync(parent, 0o700);
  if (previous.existed) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backup = `${settingsPath}.bak-pawin-brain-${stamp}-${process.pid}`;
    fs.copyFileSync(settingsPath, backup);
    fs.chmodSync(backup, 0o600);
    process.stdout.write(`Claude settings backup: ${backup}\n`);
  }
  const temporary = `${settingsPath}.tmp-pawin-brain-${process.pid}`;
  try {
    fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, settingsPath);
    fs.chmodSync(settingsPath, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return true;
}

function render(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main() {
  const command = process.argv[2] || '--install';
  if (command === '--help' || command === '-h') {
    process.stdout.write(
      'Usage: install-hooks.sh [--install|--uninstall|--smoke-check]\n'
    );
    return;
  }
  if (!['--install', '--uninstall', '--smoke-check'].includes(command)) {
    fail(`unknown option: ${command}`);
  }

  if (command === '--smoke-check') {
    bootstrap();
    smokeCheck();
    process.stdout.write('Claude runtime smoke check passed\n');
    return;
  }

  const previous = readSettings();
  const removed = removeOwnedHooks(previous.config);

  if (command === '--uninstall') {
    if (!previous.existed || removed === 0) {
      process.stdout.write('Pawin-Brain Claude hooks already absent\n');
      return;
    }
    const changed = backupAndWrite(previous, render(previous.config));
    process.stdout.write(changed
      ? 'Pawin-Brain Claude hooks uninstalled; unrelated settings preserved\n'
      : 'Pawin-Brain Claude hooks already absent\n');
    return;
  }

  bootstrap();
  smokeCheck();
  addHooks(previous.config);
  const changed = backupAndWrite(previous, render(previous.config));
  process.stdout.write(changed
    ? 'Pawin-Brain Claude hooks installed; runtime smoke check passed\n'
    : 'Pawin-Brain Claude hooks already up to date; runtime smoke check passed\n');
}

main();
