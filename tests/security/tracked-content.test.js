'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const TEXT_EXTENSIONS = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.plist',
  '.py',
  '.sh',
  '.template',
  '.txt',
  '.yml',
  '.yaml'
]);

function repositoryFiles() {
  const result = spawnSync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z'
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}

test('public repository text contains no personal machine paths or credential shapes', () => {
  const findings = [];
  const checks = [
    {
      name: 'personal macOS home path',
      pattern: /\/Users\/(?!YOUR_USERNAME(?:\/|$))[^/\s"'<>]+/g
    },
    {
      name: 'Windows user profile path',
      pattern: /[A-Za-z]:\\Users\\(?!YOUR_USERNAME(?:\\|$))[^\\\s"'<>]+/g
    },
    {
      name: 'Windows slash user profile path',
      pattern: /[A-Za-z]:\/Users\/(?!YOUR_USERNAME(?:\/|$))[^/\s"'<>]+/g
    },
    {
      name: 'Windows source-escaped user profile path',
      pattern: /[A-Za-z]:\\\\Users\\\\(?!YOUR_USERNAME(?:\\\\|$))[^\\\s"'<>]+/g
    },
    {
      name: 'Linux home path',
      pattern: /\/home\/(?!YOUR_USERNAME(?:\/|$))[^/\s"'<>]+/g
    },
    {
      name: 'OpenAI-style secret',
      pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g
    },
    {
      name: 'GitHub token',
      pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
    },
    {
      name: 'AWS access key',
      pattern: /\bAKIA[0-9A-Z]{16}\b/g
    },
    {
      name: 'private key',
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
    }
  ];

  for (const relative of repositoryFiles()) {
    const extension = path.extname(relative).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(ROOT, relative);
    let content;
    try { content = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    for (const check of checks) {
      check.pattern.lastIndex = 0;
      if (check.pattern.test(content)) findings.push(`${relative}: ${check.name}`);
    }
  }
  assert.deepEqual(findings, []);
});

test('runtime-data sentinels are not tracked at repository root', () => {
  const tracked = new Set(repositoryFiles());
  const forbidden = [
    'IDENTITY.md',
    'STATE.md',
    'last_activity.json',
    'lessons/INDEX.json',
    'memory/MEMORY.md',
    'v2/data/audit-log.jsonl',
    'v3/stuck-flag.json',
    'v4/last-trigger.json',
    'v6/loop-worklog/session.md',
    'zcode-shim/sessions/session.jsonl'
  ];
  for (const relative of forbidden) {
    assert.equal(tracked.has(relative), false, `runtime data is tracked: ${relative}`);
  }
});
