'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const RUNTIME_FILES = [
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

function copyPackage(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const relative of [
    'install-zcode-hooks.sh',
    'install-zcode-hooks.js',
    'scripts',
    'v2/scripts',
    'v3/scripts',
    'v4/scripts',
    'zcode-shim',
    'plugins/pawin-brain/scripts',
    'plugins/pawin-brain/templates',
  ]) {
    const source = path.join(ROOT, relative);
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
}

function makeFixture(t, options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-zcode-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const home = path.join(sandbox, options.spaces ? 'home with spaces' : 'home');
  fs.mkdirSync(home, { recursive: true });
  const source = options.sourceIsTarget
    ? path.join(home, '.claude-brain')
    : path.join(sandbox, options.spaces ? 'package source with spaces' : 'package-source');
  const brain = options.sourceIsTarget
    ? source
    : path.join(sandbox, options.spaces ? 'brain data with spaces' : 'brain-data');
  copyPackage(source);

  const configPath = path.join(
    sandbox,
    options.spaces ? 'zcode config with spaces' : 'zcode-config',
    'config.json'
  );
  if (!options.missingConfig) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      hooks: { enabled: false, events: {} },
      preserveMe: { value: true },
    }, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    sandbox,
    home,
    source,
    brain,
    configPath,
    preserveExpected: !options.missingConfig,
  };
}

function envFor(fixture, extra = {}) {
  return {
    ...process.env,
    HOME: fixture.home,
    CLAUDE_BRAIN_DIR: fixture.brain,
    ZCODE_CONFIG_PATH: fixture.configPath,
    ...extra,
  };
}

function runInstall(fixture, args = [], extraEnv = {}) {
  const env = envFor(fixture);
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return spawnSync('/bin/sh', [
    path.join(fixture.source, 'install-zcode-hooks.sh'),
    ...args,
  ], {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
}

function runHook(fixture, relative, args, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(fixture.brain, relative), ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: envFor(fixture, extraEnv),
    timeout: 30000,
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function assertInstalled(fixture) {
  for (const relative of RUNTIME_FILES) {
    assert.ok(fs.existsSync(path.join(fixture.brain, relative)), `missing ${relative}`);
  }
  for (const relative of [
    '',
    'lessons',
    'state',
    'memory',
    'diary',
    'v2/data',
    'v3',
    'v4',
    'v5/ingested',
    'v6/state',
    'v6/loop-worklog',
    'qmd/index',
  ]) {
    assert.equal(mode(path.join(fixture.brain, relative)), 0o700, `insecure dir ${relative}`);
  }
  for (const relative of [
    'IDENTITY.md',
    'STATE.md',
    'config.json',
    'lessons/INDEX.json',
    'memory/MEMORY.md',
    'v6/config.json',
  ]) {
    assert.equal(mode(path.join(fixture.brain, relative)), 0o600, `insecure seed ${relative}`);
  }
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  if (fixture.preserveExpected) assert.equal(config.preserveMe.value, true);
  assert.equal(config.hooks.enabled, true);
  for (const event of [
    'UserPromptSubmit',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
  ]) {
    assert.ok(config.hooks.events[event], `missing configured ${event} hook`);
  }

  const inject = runHook(
    fixture,
    'zcode-shim/zcode-hook-router.js',
    ['inject-context'],
    { session_id: 'installed-smoke', prompt: '实现一个本地功能' }
  );
  assert.equal(inject.status, 0, inject.stderr);
  const output = JSON.parse(inject.stdout);
  assert.match(output.additionalContext, /<brain-context>/);
}

test('standard README install succeeds when package source equals Brain target', t => {
  const fixture = makeFixture(t, { sourceIsTarget: true });
  const result = runInstall(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /smoke check passed/i);
  assertInstalled(fixture);
  const second = runInstall(fixture);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already up to date/i);
  assertInstalled(fixture);
});

test('custom Brain data root receives the complete ZCode runtime', t => {
  const fixture = makeFixture(t);
  const result = runInstall(fixture);
  assert.equal(result.status, 0, result.stderr);
  assertInstalled(fixture);
});

test('fresh ZCode install creates a private config and uninstall restores the prior enabled state', t => {
  const fixture = makeFixture(t, { missingConfig: true });
  const installed = runInstall(fixture);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assertInstalled(fixture);
  assert.equal(mode(fixture.configPath), 0o600);
  let config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  assert.equal(config.hooks._pawinBrain.previousEnabled, false);

  const removed = runInstall(fixture, ['--uninstall']);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  assert.equal(config.hooks.enabled, false);
  assert.equal(config.hooks._pawinBrain, undefined);
  for (const event of [
    'UserPromptSubmit',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
  ]) {
    assert.equal(config.hooks.events[event], undefined);
  }
  const afterFirst = fs.readFileSync(fixture.configPath, 'utf8');
  const repeated = runInstall(fixture, ['--uninstall']);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), afterFirst);
});

test('ZCode uninstall is a no-op when config and Brain data do not exist', t => {
  const fixture = makeFixture(t, { missingConfig: true });
  const result = runInstall(fixture, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /already absent/i);
  assert.equal(fs.existsSync(fixture.configPath), false);
  assert.equal(fs.existsSync(fixture.brain), false);
});

test('uninstall discovers a previously configured custom Brain root after the env override is removed', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);
  const removed = runInstall(fixture, ['--uninstall'], {
    CLAUDE_BRAIN_DIR: null,
  });
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  assert.equal(config.hooks.enabled, false);
  assert.equal(config.hooks._pawinBrain, undefined);
  assert.doesNotMatch(JSON.stringify(config), /zcode-hook-router\.js|record-prompt\.js/);
  assert.equal(config.preserveMe.value, true);
});

test('installer allows a legitimate symlinked ancestor but rejects a symlinked Brain root', t => {
  const allowed = makeFixture(t);
  const physicalParent = path.join(allowed.sandbox, 'physical-parent');
  const linkedParent = path.join(allowed.sandbox, 'linked-parent');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(physicalParent, linkedParent, 'dir');
  allowed.brain = path.join(linkedParent, 'brain');
  const throughAncestor = runInstall(allowed);
  assert.equal(throughAncestor.status, 0, throughAncestor.stderr || throughAncestor.stdout);
  assertInstalled(allowed);

  const rejected = makeFixture(t);
  const external = path.join(rejected.sandbox, 'external-brain');
  fs.mkdirSync(external);
  fs.symlinkSync(external, rejected.brain, 'dir');
  const before = fs.readFileSync(rejected.configPath, 'utf8');
  const result = runInstall(rejected);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked Brain root|unsafe install root/i);
  assert.equal(fs.readFileSync(rejected.configPath, 'utf8'), before);
});

test('installer rejects a symlink inside the Brain tree before bootstrapping target data', t => {
  const fixture = makeFixture(t);
  const external = path.join(fixture.sandbox, 'external-scripts');
  fs.mkdirSync(external);
  fs.mkdirSync(fixture.brain, { recursive: true });
  fs.symlinkSync(external, path.join(fixture.brain, 'scripts'), 'dir');
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const result = runInstall(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked install component/i);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(fixture.brain), ['scripts']);
});

test('installer rejects a symlinked sessions directory before touching config or external data', t => {
  const fixture = makeFixture(t);
  const external = path.join(fixture.sandbox, 'external-sessions');
  fs.mkdirSync(external, { mode: 0o755 });
  fs.chmodSync(external, 0o755);
  const victim = path.join(external, 'victim.jsonl');
  fs.writeFileSync(victim, 'DO NOT TOUCH\n', { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.brain, 'zcode-shim'), { recursive: true });
  fs.symlinkSync(external, path.join(fixture.brain, 'zcode-shim', 'sessions'), 'dir');
  const beforeConfig = fs.readFileSync(fixture.configPath, 'utf8');
  const beforeVictim = fs.readFileSync(victim, 'utf8');
  const beforeMode = mode(external);

  const result = runInstall(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked install component/i);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), beforeConfig);
  assert.equal(fs.readFileSync(victim, 'utf8'), beforeVictim);
  assert.equal(mode(external), beforeMode);
  assert.deepEqual(fs.readdirSync(external), ['victim.jsonl']);
});

test('package, Brain, and config paths containing spaces install cleanly', t => {
  const fixture = makeFixture(t, { spaces: true });
  const result = runInstall(fixture);
  assert.equal(result.status, 0, result.stderr);
  assertInstalled(fixture);
});

test('installer fails loudly before hook reconciliation when a dependency is missing', t => {
  const fixture = makeFixture(t);
  fs.unlinkSync(path.join(fixture.source, 'scripts/util.js'));
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const result = runInstall(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing or unsafe package file.*scripts\/util\.js/);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('installer fails loudly when the real inject smoke check returns no context', t => {
  const fixture = makeFixture(t);
  fs.writeFileSync(
    path.join(fixture.source, 'scripts/inject-context.js'),
    'process.exit(0);\n'
  );
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const result = runInstall(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /smoke check returned invalid JSON/i);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.equal(fs.existsSync(fixture.brain), false);
});

test('installer rolls runtime files back when final config reconciliation fails', t => {
  const fixture = makeFixture(t);
  const original = 'ORIGINAL RUNTIME FILE\n';
  const originalFile = path.join(fixture.brain, 'scripts/inject-context.js');
  fs.mkdirSync(path.dirname(originalFile), { recursive: true });
  fs.writeFileSync(originalFile, original, { mode: 0o700 });
  fs.writeFileSync(fixture.configPath, '{ malformed config', { mode: 0o600 });

  const result = runInstall(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot parse/i);
  assert.equal(fs.readFileSync(originalFile, 'utf8'), original);
  for (const relative of RUNTIME_FILES) {
    if (relative === 'scripts/inject-context.js') continue;
    assert.equal(
      fs.existsSync(path.join(fixture.brain, relative)),
      false,
      `left a partial runtime file: ${relative}`
    );
  }
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), '{ malformed config');
});

test('installer smoke check is dry-run and preserves pending runtime state', t => {
  const fixture = makeFixture(t);
  fs.mkdirSync(path.join(fixture.brain, 'v3'), { recursive: true });
  const stuck = path.join(fixture.brain, 'v3', 'stuck-flag.json');
  fs.writeFileSync(stuck, '{"stuck":true}\n', { mode: 0o600 });
  const result = runInstall(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(stuck), true);
  assert.equal(fs.existsSync(path.join(fixture.brain, 'last_activity.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.brain, 'v4', 'last-trigger.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.brain, 'v2', 'data', 'audit-log.jsonl')), false);
  const activationFiles = fs.readdirSync(path.join(fixture.brain, 'state'))
    .filter(name => name.startsWith('activated-'));
  assert.deepEqual(activationFiles, []);
});

test('ZCode reconciliation rejects an incomplete or symlinked bootstrap seed', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);
  const reconciler = path.join(fixture.source, 'install-zcode-hooks.js');
  const seed = path.join(fixture.brain, 'v6', 'config.json');
  fs.unlinkSync(seed);

  const missing = spawnSync(process.execPath, [reconciler, '--install'], {
    env: envFor(fixture),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /v6.*config\.json.*missing or unsafe/i);

  const external = path.join(fixture.sandbox, 'external-v6-config.json');
  fs.writeFileSync(external, '{}\n', { mode: 0o600 });
  fs.symlinkSync(external, seed);
  const symlinked = spawnSync(process.execPath, [reconciler, '--install'], {
    env: envFor(fixture),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /v6.*config\.json.*missing or unsafe/i);
  assert.equal(fs.readFileSync(external, 'utf8'), '{}\n');
});

test('record prompt contains malicious and empty session ids with private permissions', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);

  const malicious = runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: '../../outside', prompt: 'keep this inside' }
  );
  assert.equal(malicious.status, 0, malicious.stderr);

  const empty = runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: '', prompt: 'unknown session' }
  );
  assert.equal(empty.status, 0, empty.stderr);

  const long = runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: 'a'.repeat(300), prompt: 'bounded session' }
  );
  assert.equal(long.status, 0, long.stderr);

  const sessionsDir = path.join(fixture.brain, 'zcode-shim', 'sessions');
  const files = fs.readdirSync(sessionsDir);
  assert.ok(files.includes('.._.._outside.jsonl'));
  assert.ok(files.includes('unknown.jsonl'));
  assert.ok(files.includes(`${'a'.repeat(160)}.jsonl`));
  assert.match(
    fs.readFileSync(path.join(sessionsDir, '.._.._outside.jsonl'), 'utf8'),
    /keep this inside/
  );
  assert.equal(mode(sessionsDir), 0o700);
  for (const file of files) assert.equal(mode(path.join(sessionsDir, file)), 0o600);
  assert.equal(fs.existsSync(path.join(fixture.brain, 'outside.jsonl')), false);
  assert.equal(fs.existsSync(path.join(fixture.sandbox, 'outside.jsonl')), false);

  const external = path.join(fixture.sandbox, 'external-session-target.jsonl');
  fs.writeFileSync(external, 'DO NOT TOUCH\n', { mode: 0o600 });
  fs.symlinkSync(external, path.join(sessionsDir, 'symlink-session.jsonl'));
  const symlinked = runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: 'symlink-session', prompt: 'must not follow the link' }
  );
  assert.equal(symlinked.status, 0, symlinked.stderr);
  assert.equal(fs.readFileSync(external, 'utf8'), 'DO NOT TOUCH\n');

  const tool = runHook(
    fixture,
    'zcode-shim/zcode-hook-router.js',
    ['post-tool-use'],
    {
      session_id: '../../behavior-outside',
      tool_name: 'Write',
      tool_input: { file_path: 'example.js' },
    }
  );
  assert.equal(tool.status, 0, tool.stderr);
  assert.ok(fs.existsSync(path.join(
    fixture.brain,
    'state',
    'behavior-.._.._behavior-outside.json'
  )));
  assert.equal(fs.existsSync(path.join(fixture.brain, 'behavior-outside.json')), false);
});

test('ZCode runtime adapters never follow a symlinked sessions parent', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);
  const sessionsDir = path.join(fixture.brain, 'zcode-shim', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });

  const external = path.join(fixture.sandbox, 'external-runtime-sessions');
  fs.mkdirSync(external, { mode: 0o755 });
  fs.chmodSync(external, 0o755);
  const victim = path.join(external, 'victim.jsonl');
  const original = 'EXTERNAL VICTIM\n';
  fs.writeFileSync(victim, original, { mode: 0o600 });
  fs.symlinkSync(external, sessionsDir, 'dir');
  const beforeMode = mode(external);

  const recorded = runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: 'victim', prompt: 'must not escape' }
  );
  const routed = runHook(
    fixture,
    'zcode-shim/zcode-hook-router.js',
    ['stop'],
    { session_id: 'victim', responseText: 'assistant message' }
  );
  const bridged = runHook(
    fixture,
    'zcode-shim/stop-transcript-bridge.js',
    [],
    { session_id: 'victim', responseText: 'assistant message' }
  );

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(bridged.status, 0, bridged.stderr);
  assert.equal(fs.readFileSync(victim, 'utf8'), original);
  assert.equal(mode(external), beforeMode);
  assert.deepEqual(fs.readdirSync(external), ['victim.jsonl']);
});

test('router Stop uses a 0600 transcript and always removes the session prompt', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);
  const sessionId = 'router-cleanup';
  assert.equal(runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: sessionId, prompt: 'user message' }
  ).status, 0);

  const marker = path.join(fixture.sandbox, 'router-transcript-mode.txt');
  fs.writeFileSync(path.join(fixture.brain, 'v2/scripts/stop-audit.js'), `
    const fs = require('fs');
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const payload = JSON.parse(input);
      fs.writeFileSync(process.env.MODE_MARKER, JSON.stringify({
        mode: fs.statSync(payload.transcript_path).mode & 0o777,
        sessionId: payload.session_id,
        directory: require('path').dirname(payload.transcript_path),
      }));
      process.exit(1);
    });
  `);

  const stopped = runHook(
    fixture,
    'zcode-shim/zcode-hook-router.js',
    ['stop'],
    { session_id: sessionId, responseText: 'assistant message' },
    { MODE_MARKER: marker }
  );
  assert.equal(stopped.status, 0, stopped.stderr);
  const transcript = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(transcript.mode, 0o600);
  assert.equal(transcript.sessionId, sessionId);
  assert.equal(fs.existsSync(transcript.directory), false);
  assert.equal(
    fs.existsSync(path.join(fixture.brain, 'zcode-shim/sessions', `${sessionId}.jsonl`)),
    false
  );
});

test('legacy Stop bridge contains ids, uses 0600 temp files, and cleans up on child failure', t => {
  const fixture = makeFixture(t);
  assert.equal(runInstall(fixture).status, 0);
  const sessionId = '../../bridge-outside';
  assert.equal(runHook(
    fixture,
    'zcode-shim/record-prompt.js',
    [],
    { session_id: sessionId, prompt: 'bridge user message' }
  ).status, 0);

  const marker = path.join(fixture.sandbox, 'bridge-transcript-mode.txt');
  fs.writeFileSync(path.join(fixture.brain, 'scripts/capture-lesson.js'), `
    const fs = require('fs');
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const payload = JSON.parse(input);
      fs.writeFileSync(process.env.MODE_MARKER, JSON.stringify({
        mode: fs.statSync(payload.transcript_path).mode & 0o777,
        sessionId: payload.session_id,
        directory: require('path').dirname(payload.transcript_path),
      }));
      process.exit(1);
    });
  `);

  const stopped = runHook(
    fixture,
    'zcode-shim/stop-transcript-bridge.js',
    [],
    { session_id: sessionId, responseText: 'bridge assistant message' },
    { MODE_MARKER: marker }
  );
  assert.equal(stopped.status, 0, stopped.stderr);
  const transcript = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(transcript.mode, 0o600);
  assert.equal(transcript.sessionId, '.._.._bridge-outside');
  assert.equal(fs.existsSync(transcript.directory), false);
  assert.equal(
    fs.existsSync(path.join(
      fixture.brain,
      'zcode-shim/sessions',
      '.._.._bridge-outside.jsonl'
    )),
    false
  );
  assert.equal(fs.existsSync(path.join(fixture.brain, 'bridge-outside.jsonl')), false);
});
