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
  if (!target) {
    throw new Error(`unsafe Brain directory: ${target}`);
  }
  const normalized = path.resolve(target);
  const root = path.parse(normalized).root;
  const physicalTarget = resolvePhysicalTarget(normalized);
  const physicalRoot = resolvePhysicalTarget(root);
  const physicalHome = resolvePhysicalTarget(os.homedir());
  if (
    normalized === root ||
    normalized === path.resolve(os.homedir()) ||
    physicalTarget === physicalRoot ||
    physicalTarget === physicalHome
  ) {
    throw new Error(`unsafe Brain directory: ${target}`);
  }
  return physicalTarget;
}

function resolvePhysicalTarget(target) {
  let current = path.resolve(target);
  const missing = [];
  let stat = fs.lstatSync(current, { throwIfNoEntry: false });
  while (!stat) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`unsafe Brain directory: ${target}`);
    }
    missing.unshift(path.basename(current));
    current = parent;
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
  }
  if (missing.length > 0) {
    let ancestorStat;
    try {
      ancestorStat = fs.statSync(current);
    } catch {
      throw new Error(`unsafe Brain directory: ${target}`);
    }
    if (!ancestorStat.isDirectory()) {
      throw new Error(`unsafe Brain directory: ${target}`);
    }
  }
  let physical;
  try {
    physical = fs.realpathSync(current);
  } catch {
    throw new Error(`unsafe Brain directory: ${target}`);
  }
  return path.resolve(physical, ...missing);
}

function secureExistingSeed(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`unsafe Brain seed target: ${target}`);
  }
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return false;
}

function writeIfMissing(source, target) {
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    return secureExistingSeed(target);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = fs.readFileSync(source);
  try {
    fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return secureExistingSeed(target);
    throw error;
  }
}

function ensurePrivateDirectory(root, relative = '') {
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe Brain runtime directory: ${relative}`);
    }
    if (process.platform !== 'win32') fs.chmodSync(current, 0o700);
  }
}

function bootstrap() {
  assertSafeBrainDir(BRAIN_DIR);
  fs.mkdirSync(BRAIN_DIR, { recursive: true, mode: 0o700 });
  assertSafeBrainDir(BRAIN_DIR);
  const rootStat = fs.lstatSync(BRAIN_DIR);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`unsafe Brain directory: ${BRAIN_DIR}`);
  }
  if (process.platform !== 'win32') fs.chmodSync(BRAIN_DIR, 0o700);
  for (const relative of REQUIRED_DIRS) {
    ensurePrivateDirectory(BRAIN_DIR, relative);
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

module.exports = {
  BRAIN_DIR,
  PLUGIN_ROOT,
  bootstrap,
  assertSafeBrainDir,
  ensurePrivateDirectory,
  resolvePhysicalTarget,
  secureExistingSeed
};
