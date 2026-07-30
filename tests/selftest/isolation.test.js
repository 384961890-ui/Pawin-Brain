'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function treeHash(root) {
  const rows = [];
  function walk(target, relative = '.') {
    if (!fs.existsSync(target)) return rows.push(`${relative}|missing`);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      rows.push(`${relative}|dir|${stat.mode & 0o777}`);
      for (const name of fs.readdirSync(target).sort()) {
        walk(path.join(target, name), path.join(relative, name));
      }
    } else {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      rows.push(`${relative}|file|${stat.mode & 0o777}|${hash}`);
    }
  }
  walk(root);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

test('root and v6 selftests never touch the configured live Brain', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-selftest-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brain = path.join(home, 'configured-live-brain');
  fs.mkdirSync(path.join(brain, 'state'), { recursive: true });
  fs.mkdirSync(path.join(brain, 'v6', 'state'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'config.json'), '{"enabled":false,"sentinel":"keep"}\n');
  fs.writeFileSync(path.join(brain, 'v6', 'config.json'), '{"enabled":false,"sentinel":"keep"}\n');
  fs.writeFileSync(path.join(brain, 'state', 'sentinel.txt'), 'keep\n');
  const before = treeHash(brain);

  for (const script of [
    path.join(ROOT, 'scripts', 'selftest.js'),
    path.join(ROOT, 'v6', 'scripts', 'selftest.js')
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        HOME: home,
        BRAIN_DIR: brain,
        CLAUDE_BRAIN_DIR: brain
      },
      encoding: 'utf8',
      timeout: 20000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /7\/7 PASS/);
  }
  assert.equal(treeHash(brain), before);
});
