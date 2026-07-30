#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'codex-runtime-allowlist.json');
const FORBIDDEN_SEGMENTS = new Set([
  '.git',
  '.github',
  'diary',
  'lessons',
  'memory',
  'state',
  'loop-worklog',
  'ingested',
  'sessions'
]);
const FORBIDDEN_BASENAMES = new Set([
  'IDENTITY.md',
  'STATE.md',
  'last_activity.json',
  'last-trigger.json',
  'stuck-flag.json'
]);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertGeneratedTarget(target, root = ROOT) {
  const expected = path.join(root, 'plugins/pawin-brain/runtime');
  if (path.resolve(target) !== expected) throw new Error(`unsafe runtime target: ${target}`);
}

function normalizeAllowlistedPath(relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('runtime allowlist entries must be non-empty strings');
  }
  const normalized = relative.split('\\').join('/');
  if (
    normalized !== path.posix.normalize(normalized) ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('\0')
  ) {
    throw new Error(`unsafe runtime allowlist entry: ${relative}`);
  }
  const segments = normalized.split('/');
  if (
    segments.some(segment => FORBIDDEN_SEGMENTS.has(segment)) ||
    FORBIDDEN_BASENAMES.has(path.posix.basename(normalized))
  ) {
    throw new Error(`runtime allowlist contains private/runtime data: ${relative}`);
  }
  return normalized;
}

function loadAllowlist(allowlistPath = ALLOWLIST_PATH) {
  const document = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  if (document.schema !== 1 || !Array.isArray(document.files)) {
    throw new Error('invalid Codex runtime allowlist');
  }
  const files = document.files.map(normalizeAllowlistedPath);
  if (new Set(files).size !== files.length) {
    throw new Error('duplicate Codex runtime allowlist entry');
  }
  return files.sort();
}

function assertSafeSource(root, relative) {
  let current = root;
  const rootStat = fs.lstatSync(current, { throwIfNoEntry: false });
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`unsafe public source root: ${root}`);
  }
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    const isFinal = index === segments.length - 1;
    if (
      !stat ||
      stat.isSymbolicLink() ||
      (isFinal ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(`missing or unsafe public v8.3.1 source: ${relative}`);
    }
  }
  return current;
}

function buildRuntime({
  root = ROOT,
  pluginRoot = path.join(root, 'plugins/pawin-brain'),
  allowlistPath = path.join(root, 'scripts/codex-runtime-allowlist.json')
} = {}) {
  const runtimeRoot = path.join(pluginRoot, 'runtime');
  const manifestPath = path.join(pluginRoot, 'runtime-manifest.json');
  const relativeSources = loadAllowlist(allowlistPath);
  const sources = relativeSources.map(relative => assertSafeSource(root, relative));

  assertGeneratedTarget(runtimeRoot, root);
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const files = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const relative = relativeSources[i];
    const target = path.join(runtimeRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode & 0o777);
    files.push({ path: relative.split(path.sep).join('/'), sha256: sha256(target) });
  }

  const manifest = {
    schema: 1,
    baseline: 'Brain v8.3.1 public hardening',
    baselineSourceCommit: process.env.PAWIN_BASELINE_COMMIT ||
      'same commit as this generated manifest',
    adapter: 'Codex host adapter over an exact public source allowlist',
    files
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return { files, manifest, manifestPath, runtimeRoot };
}

function main() {
  const result = buildRuntime();
  const files = result.files;
  process.stdout.write(`Built Codex runtime: ${files.length} public v8.3.1 files\n`);
}

if (require.main === module) main();

module.exports = {
  buildRuntime,
  assertSafeSource,
  loadAllowlist,
  normalizeAllowlistedPath
};
