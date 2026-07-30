'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function assertPrivateTree(root) {
  const walk = target => {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false, `unexpected symlink: ${target}`);
    if (stat.isDirectory()) {
      assert.equal(stat.mode & 0o077, 0, `directory is not private: ${target}`);
      for (const name of fs.readdirSync(target)) walk(path.join(target, name));
    } else if (stat.isFile()) {
      assert.equal(stat.mode & 0o077, 0, `file is not private: ${target}`);
    }
  };
  walk(root);
}

test('lesson capture and shared atomic writers produce private runtime files', {
  skip: process.platform === 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-private-modes-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const brain = path.join(sandbox, 'brain');
  const lessons = path.join(brain, 'lessons');
  fs.mkdirSync(lessons, { recursive: true, mode: 0o700 });
  fs.chmodSync(brain, 0o700);
  fs.chmodSync(lessons, 0o700);
  fs.writeFileSync(
    path.join(brain, 'config.json'),
    '{"qmd_enabled":false,"debug":false}\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(lessons, 'INDEX.json'),
    '{"lessons":[]}\n',
    { mode: 0o600 }
  );

  const atomicTarget = path.join(brain, 'state', 'atomic.json');
  const atomic = spawnSync(process.execPath, [
    '-e',
    'require(process.argv[1]).writeFileAtomic(process.argv[2], "{}\\n")',
    path.join(ROOT, 'scripts/util.js'),
    atomicTarget,
  ], {
    env: { ...process.env, CLAUDE_BRAIN_DIR: brain },
    encoding: 'utf8',
  });
  assert.equal(atomic.status, 0, atomic.stderr);

  const transcript = path.join(sandbox, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: '不是这样 你又犯了 我之前说过这个要求',
      }],
    },
  })}\n`, { mode: 0o600 });
  const captured = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/capture-lesson.js'),
  ], {
    input: JSON.stringify({
      session_id: 'private-mode-test',
      transcript_path: transcript,
    }),
    env: { ...process.env, CLAUDE_BRAIN_DIR: brain },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(captured.status, 0, captured.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(lessons, 'INDEX.json'), 'utf8'));
  assert.equal(index.lessons.length, 1);
  assert.ok(
    fs.readdirSync(lessons).some(name => /^\d{4}-\d{2}\.md$/.test(name)),
    'capture did not create the monthly lesson file'
  );
  assertPrivateTree(brain);
});

test('sleep-loop logs and data updates use private permissions', {
  skip: process.platform === 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-sleep-modes-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const brain = path.join(sandbox, 'brain');
  const data = path.join(brain, 'v2', 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.chmodSync(brain, 0o700);
  fs.chmodSync(path.join(brain, 'v2'), 0o700);
  fs.chmodSync(data, 0o700);
  fs.writeFileSync(
    path.join(data, 'pending-review.json'),
    '{"pending":[]}\n',
    { mode: 0o600 }
  );
  for (const script of [
    'nightly-consolidate.py',
    'calibration-update.py',
  ]) {
    const result = spawnSync('python3', [
      path.join(ROOT, 'v2/scripts/sleep-loop', script),
    ], {
      env: { ...process.env, CLAUDE_BRAIN_DIR: brain },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assertPrivateTree(brain);
});

test('an empty Brain environment falls back to HOME instead of the working directory', {
  skip: process.platform === 'win32',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-sleep-empty-env-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const home = path.join(sandbox, 'home');
  const cwd = path.join(sandbox, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);

  for (const script of [
    'nightly-consolidate.py',
    'calibration-update.py',
  ]) {
    const result = spawnSync('python3', [
      path.join(ROOT, 'v2/scripts/sleep-loop', script),
    ], {
      cwd,
      env: { ...process.env, HOME: home, CLAUDE_BRAIN_DIR: '' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const defaultBrain = path.join(home, '.claude-brain');
  assert.equal(fs.existsSync(path.join(cwd, 'v2')), false);
  assert.ok(fs.existsSync(path.join(defaultBrain, 'v2', 'logs')));
  assertPrivateTree(defaultBrain);
});
