'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const CAPTURE = path.join(ROOT, 'scripts/capture-lesson.js');

test('capture-lesson contains hostile session ids inside the Brain state directory', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-capture-session-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const brain = path.join(base, 'brain');
  const lessons = path.join(brain, 'lessons');
  const state = path.join(brain, 'state');
  fs.mkdirSync(lessons, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(brain, 'config.json'), JSON.stringify({ qmd_enabled: false }));
  fs.writeFileSync(path.join(lessons, 'INDEX.json'), '{"lessons":[]}\n');

  const transcript = path.join(base, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    role: 'user',
    content: '我之前说过了 你又这样 同一个问题不要再犯'
  }) + '\n');
  const hostile = '../../../../outside/../../pwned';
  const result = spawnSync(process.execPath, [CAPTURE], {
    input: JSON.stringify({
      session_id: hostile,
      transcript_path: transcript
    }),
    env: {
      ...process.env,
      CLAUDE_BRAIN_DIR: brain
    },
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);

  const monthFile = fs.readdirSync(lessons).find(name => /^\d{4}-\d{2}\.md$/.test(name));
  assert.ok(monthFile, 'the correction signal should create a draft lesson');
  const lesson = fs.readFileSync(path.join(lessons, monthFile), 'utf8');
  assert.doesNotMatch(lesson, /\.\.\//);
  const sessionLine = lesson.match(/^\*\*session:\*\* (.+)$/m);
  assert.ok(sessionLine);
  assert.match(sessionLine[1], /^[a-zA-Z0-9._-]{1,160}$/);
  assert.match(sessionLine[1], /outside.*pwned/);

  const allFiles = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else allFiles.push(absolute);
    }
  };
  walk(base);
  assert.equal(allFiles.some(file => path.basename(file) === 'pwned.json'), false);
});
