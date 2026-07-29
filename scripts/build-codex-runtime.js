#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins/pawin-brain');
const RUNTIME_ROOT = path.join(PLUGIN_ROOT, 'runtime');
const MANIFEST_PATH = path.join(PLUGIN_ROOT, 'runtime-manifest.json');

const ROOT_FILES = [
  'LICENSE',
  'INDEX.md',
  'README.md',
  'brain-readme.md',
  'CHANGELOG.md',
  'CHANGELOG-v8.3.md',
  'config.example.json',
  'config.json.example'
];
const ROOT_DIRS = [
  'scripts',
  'tools',
  'v2',
  'v3',
  'v4',
  'v5',
  'v6',
  'memory-spec',
  'qmd-engine'
];

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(absolute));
    else if (
      entry.isFile() &&
      path.relative(ROOT, absolute) !== 'scripts/build-codex-runtime.js'
    ) result.push(absolute);
  }
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertGeneratedTarget(target) {
  const expected = path.join(ROOT, 'plugins/pawin-brain/runtime');
  if (path.resolve(target) !== expected) throw new Error(`unsafe runtime target: ${target}`);
}

function main() {
  const sources = [
    ...ROOT_FILES.map(file => path.join(ROOT, file)),
    ...ROOT_DIRS.flatMap(directory => filesUnder(path.join(ROOT, directory)))
  ].sort();
  for (const source of sources) {
    if (!fs.existsSync(source)) throw new Error(`missing public v8.3 source: ${source}`);
  }

  assertGeneratedTarget(RUNTIME_ROOT);
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });

  const files = [];
  for (const source of sources) {
    const relative = path.relative(ROOT, source);
    const target = path.join(RUNTIME_ROOT, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
    files.push({ path: relative.split(path.sep).join('/'), sha256: sha256(target) });
  }

  const manifest = {
    schema: 1,
    baseline: 'Brain v8.3 public final',
    baselineSourceCommit: '4ba244f27482025cf677d513e244df44db3ab563',
    adapter: 'Codex host compatibility changes only',
    files
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Built Codex runtime: ${files.length} public v8.3 files\n`);
}

main();
