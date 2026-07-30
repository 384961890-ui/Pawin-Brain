'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function ignored(relative) {
  return spawnSync('git', ['check-ignore', '--no-index', '-q', relative], {
    cwd: ROOT,
    encoding: 'utf8'
  }).status === 0;
}

test('legacy clone-as-runtime paths cannot be staged accidentally', () => {
  for (const relative of [
    'IDENTITY.md',
    'STATE.md',
    'last_activity.json',
    'lessons/INDEX.json',
    'lessons/2026-07.md',
    'memory/MEMORY.md',
    'diary/2026-07-30.md',
    'v2/data/audit-log.jsonl',
    'v3/stuck-flag.json',
    'v4/last-trigger.json',
    'v5/ingested/private.md',
    'v6/state/throttle.json',
    'v6/loop-worklog/session.md',
    'zcode-shim/sessions/session.jsonl',
    'qmd/index/private.bin',
    'v2/logs/pending-review.md',
    'crash.tmp.12345',
    'v2/scripts/stop-audit.js.tmp.12345'
  ]) {
    assert.equal(ignored(relative), true, `runtime data is stageable: ${relative}`);
  }
});

test('public source and bootstrap templates remain trackable', () => {
  for (const relative of [
    'README.md',
    'v4/DESIGN.md',
    'scripts/capture-lesson.js',
    'plugins/pawin-brain/templates/IDENTITY.md',
    'plugins/pawin-brain/templates/STATE.md',
    'plugins/pawin-brain/templates/config.json'
  ]) {
    assert.equal(ignored(relative), false, `public source was over-ignored: ${relative}`);
  }
});

test('Stop hook child budgets fit inside every host timeout', () => {
  const claude = require(path.join(ROOT, 'scripts/claude-hook-router.js'));
  const codex = require(path.join(
    ROOT,
    'plugins/pawin-brain/scripts/codex-hook-router.js'
  ));
  const zcode = require(path.join(ROOT, 'zcode-shim/zcode-hook-router.js'));

  const claudeCaps = claude.STOP_HANDLERS
    .reduce((total, handler) => total + handler.timeout, 0);
  const codexCaps = Object.values(codex.STOP_TIMEOUTS)
    .reduce((total, timeout) => total + timeout, 0);
  const zcodeCaps = Object.values(zcode.STOP_TIMEOUTS)
    .reduce((total, timeout) => total + timeout, 0);
  assert.ok(claudeCaps <= claude.STOP_BUDGET_MS);
  assert.ok(codexCaps <= codex.STOP_BUDGET_MS);
  assert.ok(zcodeCaps <= zcode.STOP_BUDGET_MS);

  const codexHooks = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'plugins/pawin-brain/hooks/hooks.json'),
    'utf8'
  ));
  const codexOuterMs = codexHooks.hooks.Stop[0].hooks[0].timeout * 1000;
  assert.ok(codex.STOP_BUDGET_MS < codexOuterMs);

  const claudeInstaller = fs.readFileSync(
    path.join(ROOT, 'install-claude-hooks.js'),
    'utf8'
  );
  const zcodeInstaller = fs.readFileSync(
    path.join(ROOT, 'install-zcode-hooks.js'),
    'utf8'
  );
  assert.match(claudeInstaller, /Stop:\s*\['stop',\s*30\]/);
  assert.match(zcodeInstaller, /events\.Stop\.push\(processHook\('stop',\s*45000\)\)/);
  assert.ok(claude.STOP_BUDGET_MS < 30000);
  assert.ok(zcode.STOP_BUDGET_MS < 45000);
});

test('CI third-party actions are pinned to immutable commit SHAs', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/test.yml'),
    'utf8'
  );
  assert.doesNotMatch(workflow, /uses:\s*actions\/[^@\s]+@v\d+/);
  for (const action of ['checkout', 'setup-node']) {
    assert.match(
      workflow,
      new RegExp(`uses:\\s*actions/${action}@[a-f0-9]{40}`)
    );
  }
});
