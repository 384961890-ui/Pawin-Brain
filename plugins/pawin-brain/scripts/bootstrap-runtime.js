#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BRAIN_DIR = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.join(os.homedir(), '.claude-brain')
);

const REQUIRED_DIRS = [
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
  'qmd/index'
];

const SEEDS = [
  ['templates/IDENTITY.md', 'IDENTITY.md'],
  ['templates/STATE.md', 'STATE.md'],
  ['templates/config.json', 'config.json'],
  ['templates/lessons-index.json', 'lessons/INDEX.json'],
  ['templates/memory-index.md', 'memory/MEMORY.md'],
  ['templates/v6-config.json', 'v6/config.json']
];

function assertSafeBrainDir(target) {
  const root = path.parse(target).root;
  if (!target || target === root || target === os.homedir()) {
    throw new Error(`unsafe Brain directory: ${target}`);
  }
}

function writeIfMissing(source, target) {
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = fs.readFileSync(source);
  try {
    fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function bootstrap() {
  assertSafeBrainDir(BRAIN_DIR);
  fs.mkdirSync(BRAIN_DIR, { recursive: true, mode: 0o700 });
  for (const relative of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(BRAIN_DIR, relative), { recursive: true, mode: 0o700 });
  }

  const created = [];
  for (const [sourceRelative, targetRelative] of SEEDS) {
    const source = path.join(PLUGIN_ROOT, sourceRelative);
    const target = path.join(BRAIN_DIR, targetRelative);
    if (writeIfMissing(source, target)) created.push(targetRelative);
  }
  return { brainDir: BRAIN_DIR, created };
}

if (require.main === module) {
  try {
    const result = bootstrap();
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`pawin-brain bootstrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { BRAIN_DIR, PLUGIN_ROOT, bootstrap, assertSafeBrainDir };
