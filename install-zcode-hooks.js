#!/usr/bin/env node
/**
 * Idempotently reconcile claude-brain hooks in ~/.zcode/cli/config.json.
 * Unrelated hooks, plugins, MCP servers, and settings are preserved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = os.homedir();
const configPath = process.env.ZCODE_CONFIG_PATH || path.join(home, '.zcode', 'cli', 'config.json');
const brainDir = process.env.CLAUDE_BRAIN_DIR || path.join(home, '.claude-brain');
const nodeBin = process.env.CLAUDE_BRAIN_NODE || process.execPath;
const router = path.join(brainDir, 'zcode-shim', 'zcode-hook-router.js');
const runtimeFiles = [
  'scripts/inject-context.js',
  'scripts/util.js',
  'scripts/link-expand.js',
  'scripts/track-behavior.js',
  'scripts/capture-lesson.js',
  'scripts/decay-lessons.js',
  'scripts/efficacy.js',
  'scripts/update-state.js',
  'v2/scripts/stop-audit.js',
  'v2/scripts/finish-the-work.js',
  'v3/scripts/think-detect.js',
  'v4/scripts/idea-loop-trigger.js',
  'zcode-shim/record-prompt.js',
  'zcode-shim/zcode-hook-router.js',
  'zcode-shim/stop-transcript-bridge.js',
];
const bootstrapSeeds = [
  'IDENTITY.md',
  'STATE.md',
  'config.json',
  'lessons/INDEX.json',
  'memory/MEMORY.md',
  'v6/config.json',
];

const command = process.argv[2] || '--install';
if (command === '--help' || command === '-h') {
  process.stdout.write('Usage: install-zcode-hooks.sh [--install|--uninstall]\n');
  process.exit(0);
}
if (!['--install', '--uninstall'].includes(command)) {
  fail(`unknown option: ${command}`);
}
if (!fs.existsSync(configPath)) {
  if (command === '--uninstall') {
    process.stdout.write('Pawin-Brain ZCode hooks already absent\n');
    process.exit(0);
  }
  validateRuntime();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(configPath), 0o700);
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ hooks: { enabled: false, events: {} } }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  );
} else if (command === '--install') {
  validateRuntime();
}

const before = fs.readFileSync(configPath, 'utf8');
let config;
try { config = JSON.parse(before); }
catch (error) { fail(`cannot parse ${configPath}: ${error.message}`); }

const existingHooks = config.hooks &&
  typeof config.hooks === 'object' &&
  !Array.isArray(config.hooks)
  ? config.hooks
  : null;
const existingEvents = existingHooks?.events &&
  typeof existingHooks.events === 'object' &&
  !Array.isArray(existingHooks.events)
  ? existingHooks.events
  : {};
const ownership = existingHooks?._pawinBrain;
const hadOwnership = Boolean(
  ownership &&
  typeof ownership === 'object' &&
  ownership.owner === 'pawin-brain-v8'
);
const previousHooksEnabled = hadOwnership &&
  typeof ownership.previousEnabled === 'boolean'
  ? ownership.previousEnabled
  : Boolean(existingHooks?.enabled);
const configuredBrainRoots = new Set([brainDir, path.join(home, '.claude-brain')]);
for (const groups of Object.values(existingEvents)) {
  for (const group of groups || []) {
    for (const hook of group.hooks || []) {
      for (const arg of Array.isArray(hook.args) ? hook.args : []) {
        if (typeof arg !== 'string' || !path.isAbsolute(arg)) continue;
        const normalized = path.normalize(arg);
        for (const suffix of [
          path.join('zcode-shim', 'zcode-hook-router.js'),
          path.join('zcode-shim', 'record-prompt.js'),
        ]) {
          const marker = `${path.sep}${suffix}`;
          if (normalized.endsWith(marker)) {
            configuredBrainRoots.add(normalized.slice(0, -marker.length));
          }
        }
        const marker = `${path.sep}.claude-brain${path.sep}`;
        const index = normalized.indexOf(marker);
        if (index >= 0) {
          configuredBrainRoots.add(normalized.slice(0, index + marker.length - 1));
        }
      }
    }
  }
}
const runtimeRoots = [...configuredBrainRoots];

const ownedTargets = new Set(runtimeRoots.flatMap(root => [
  path.join(root, 'scripts', 'debug-up.js'),
  path.join(root, 'scripts', 'inject-context.js'),
  path.join(root, 'scripts', 'track-behavior.js'),
  path.join(root, 'v2', 'scripts', 'stop-audit.js'),
  path.join(root, 'v2', 'scripts', 'finish-the-work.js'),
  path.join(root, 'v3', 'scripts', 'think-detect.js'),
  path.join(root, 'zcode-shim', 'stop-transcript-bridge.js'),
  path.join(root, 'zcode-shim', 'record-prompt.js'),
  path.join(root, 'scripts', 'capture-lesson.js'),
  path.join(root, 'scripts', 'update-state.js'),
  path.join(root, 'zcode-shim', 'zcode-hook-router.js'),
]));

const isBrainRuntimePath = value =>
  typeof value === 'string' && value.includes(`${path.sep}.claude-brain${path.sep}`);
const isLegacyBrainHook = value =>
  isBrainRuntimePath(value) && [
    `${path.sep}scripts${path.sep}debug-up.js`,
    `${path.sep}scripts${path.sep}inject-context.js`,
    `${path.sep}scripts${path.sep}track-behavior.js`,
    `${path.sep}v2${path.sep}scripts${path.sep}stop-audit.js`,
    `${path.sep}v2${path.sep}scripts${path.sep}finish-the-work.js`,
    `${path.sep}v3${path.sep}scripts${path.sep}think-detect.js`,
    `${path.sep}zcode-shim${path.sep}stop-transcript-bridge.js`,
    `${path.sep}zcode-shim${path.sep}record-prompt.js`,
    `${path.sep}scripts${path.sep}capture-lesson.js`,
    `${path.sep}scripts${path.sep}update-state.js`,
    `${path.sep}zcode-shim${path.sep}zcode-hook-router.js`,
  ].some(suffix => value.endsWith(suffix));

function hookIsOwned(hook) {
  const args = Array.isArray(hook.args) ? hook.args : [];
  if (args.some(arg => {
    if (typeof arg !== 'string' || !path.isAbsolute(arg)) return false;
    const normalized = path.normalize(arg);
    return ownedTargets.has(normalized) || isLegacyBrainHook(normalized);
  })) return true;
  return typeof hook.command === 'string' && (
    [...ownedTargets].some(target => hook.command.includes(target)) ||
    isLegacyBrainHook(hook.command)
  );
}

let removed = 0;
for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
  if (!Array.isArray(existingEvents[event])) continue;
  const groups = existingEvents[event].flatMap(group => {
    const groupHooks = Array.isArray(group?.hooks) ? group.hooks : [];
    const remaining = groupHooks.filter(hook => !hookIsOwned(hook));
    removed += groupHooks.length - remaining.length;
    return remaining.length > 0 ? [{ ...group, hooks: remaining }] : [];
  });
  if (groups.length > 0) existingEvents[event] = groups;
  else delete existingEvents[event];
}

if (command === '--uninstall') {
  if (removed === 0 && !hadOwnership) {
    process.stdout.write('Pawin-Brain ZCode hooks already absent\n');
    process.exit(0);
  }
  if (existingHooks && hadOwnership) {
    existingHooks.enabled = previousHooksEnabled;
    delete existingHooks._pawinBrain;
  }
  writeConfig(`${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write('Pawin-Brain ZCode hooks uninstalled; unrelated settings preserved\n');
  process.exit(0);
}

const hooks = existingHooks || (config.hooks = {});
hooks._pawinBrain = {
  owner: 'pawin-brain-v8',
  previousEnabled: previousHooksEnabled,
};
hooks.enabled = true;
const events = hooks.events && typeof hooks.events === 'object'
  ? hooks.events
  : (hooks.events = {});

function directProcess(script, timeoutMs) {
  return {
    hooks: [{
      type: 'process',
      command: nodeBin,
      args: [script],
      timeoutMs,
    }],
  };
}

function processHook(mode, timeoutMs) {
  return {
    hooks: [{
      type: 'process',
      command: nodeBin,
      args: [router, mode],
      timeoutMs,
    }],
  };
}

for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
  if (!Array.isArray(events[event])) events[event] = [];
}
events.UserPromptSubmit.push(directProcess(path.join(brainDir, 'zcode-shim', 'record-prompt.js'), 5000));
events.UserPromptSubmit.push(processHook('inject-context', 10000));
events.PostToolUse.push(processHook('post-tool-use', 10000));
events.PostToolUseFailure.push(processHook('post-tool-use-failure', 10000));
events.Stop.push(processHook('stop', 45000));

const after = `${JSON.stringify(config, null, 2)}\n`;
if (before === after) {
  process.stdout.write('ZCode hooks already up to date\n');
} else {
  const backup = writeConfig(after);
  process.stdout.write(`ZCode hooks updated; backup: ${backup}\n`);
}
process.stdout.write('ZCode runtime smoke check passed\n');

function writeConfig(content) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const backup = `${configPath}.bak-brain-${stamp}-${process.pid}`;
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.copyFileSync(configPath, backup);
  fs.chmodSync(backup, 0o600);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return backup;
}

function validateRuntime() {
  for (const relative of [...runtimeFiles, ...bootstrapSeeds]) {
    const file = path.join(brainDir, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      fail(`ZCode runtime smoke check: ${file} is missing or unsafe`);
    }
  }
  smokeCheck();
}

function smokeCheck() {
  const result = spawnSync(nodeBin, [router, 'inject-context'], {
    input: JSON.stringify({
      session_id: 'zcode-installer-smoke',
      prompt: '检查 Brain 安装',
    }),
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CLAUDE_BRAIN_DIR: brainDir,
      CLAUDE_BRAIN_HOST: 'zcode',
      BRAIN_DRY_RUN: '1',
    },
  });
  if (result.error) fail(`ZCode runtime smoke check failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`ZCode runtime smoke check failed with status ${result.status}: ${result.stderr || ''}`);
  }
  let output;
  try {
    output = JSON.parse((result.stdout || '').trim());
  } catch (error) {
    fail(`ZCode runtime smoke check returned invalid JSON: ${error.message}`);
  }
  if (
    !output ||
    typeof output.additionalContext !== 'string' ||
    !output.additionalContext.includes('<brain-context>')
  ) {
    fail('ZCode runtime smoke check returned no Brain context');
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
