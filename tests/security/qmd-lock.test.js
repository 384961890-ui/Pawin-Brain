'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const QMD = path.join(ROOT, 'qmd-engine');

test('QMD dependencies and model artifacts are pinned and verifiable', t => {
  const requirements = fs.readFileSync(path.join(QMD, 'requirements.txt'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.ok(requirements.length >= 2);
  for (const requirement of requirements) {
    assert.match(requirement, /^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$/);
  }

  const lock = JSON.parse(fs.readFileSync(path.join(QMD, 'models.lock.json'), 'utf8'));
  assert.equal(lock.schema, 1);
  assert.equal(lock.models.length, 2);
  const config = fs.readFileSync(path.join(QMD, 'qmd_config.py'), 'utf8');
  for (const model of lock.models) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.match(model.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(model.size) && model.size > 0);
    assert.match(config, new RegExp(model.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const emptyModels = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-qmd-models-'));
  t.after(() => fs.rmSync(emptyModels, { recursive: true, force: true }));
  const before = fs.readdirSync(emptyModels);
  const result = spawnSync('python3', [path.join(QMD, 'verify_models.py')], {
    env: { ...process.env, QMD_MODELS_DIR: emptyModels },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.models.every(model => model.status === 'missing'));
  assert.deepEqual(fs.readdirSync(emptyModels), before);
});
