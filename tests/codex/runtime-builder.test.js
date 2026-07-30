'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const BUILDER = path.join(ROOT, 'scripts', 'build-codex-runtime.js');
const ALLOWLIST = path.join(ROOT, 'scripts', 'codex-runtime-allowlist.json');
const SENTINEL_RELATIVE = 'v6/loop-worklog/private-runtime-sentinel.md';

test('runtime builder uses an exact file allowlist and excludes unknown files', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-runtime-builder-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const sandboxRoot = path.join(sandbox, 'repo');
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
  for (const relative of allowlist.files) {
    const source = path.join(ROOT, relative);
    const target = path.join(sandboxRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const sentinel = path.join(sandboxRoot, SENTINEL_RELATIVE);
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'PRIVATE_RUNTIME_SENTINEL\n');

  const { buildRuntime } = require(BUILDER);
  buildRuntime({ root: sandboxRoot, allowlistPath: ALLOWLIST });
  const bundledSentinel = path.join(
    sandboxRoot,
    'plugins/pawin-brain/runtime',
    SENTINEL_RELATIVE
  );
  assert.equal(fs.existsSync(bundledSentinel), false);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(sandboxRoot, 'plugins/pawin-brain/runtime-manifest.json'),
    'utf8'
  ));
  assert.equal(manifest.files.some(entry => entry.path === SENTINEL_RELATIVE), false);
  assert.equal(fs.existsSync(sentinel), true, 'builder modified non-allowlisted source data');

  const external = path.join(sandbox, 'external-qmd');
  fs.cpSync(path.join(sandboxRoot, 'qmd-engine'), external, { recursive: true });
  fs.rmSync(path.join(sandboxRoot, 'qmd-engine'), { recursive: true, force: true });
  fs.symlinkSync(external, path.join(sandboxRoot, 'qmd-engine'), 'dir');
  assert.throws(
    () => buildRuntime({ root: sandboxRoot, allowlistPath: ALLOWLIST }),
    /unsafe public v8\.3\.1 source/,
    'builder followed a symlinked allowlist parent'
  );
});
