#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { BRAIN_DIR, PLUGIN_ROOT } = require('./bootstrap-runtime.js');

const RUNTIME_ROOT = path.join(PLUGIN_ROOT, 'runtime');
const REQUIRED_DATA_FILES = [
  'IDENTITY.md',
  'STATE.md',
  'config.json',
  'lessons/INDEX.json',
  'memory/MEMORY.md',
  'v6/config.json'
];
const REQUIRED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop'
];
const HOOK_CONTRACT = {
  SessionStart: { mode: 'session-start', timeout: 20, matcher: 'startup|resume' },
  UserPromptSubmit: { mode: 'user-prompt', timeout: 20 },
  PostToolUse: { mode: 'tool', timeout: 20, matcher: '*' },
  Stop: { mode: 'stop', timeout: 45 }
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeRelative(relative) {
  if (typeof relative !== 'string' || relative.length === 0) return false;
  const normalized = relative.split('\\').join('/');
  return (
    normalized === path.posix.normalize(normalized) &&
    !path.posix.isAbsolute(normalized) &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !normalized.includes('\0')
  );
}

function filesUnder(root) {
  const files = [];
  const unsafeLinks = [];
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { rootStat = null; }
  if (!rootStat) return { files, unsafeLinks };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { files, unsafeLinks: ['.'] };
  }
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        unsafeLinks.push(relative);
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  visit(root);
  return { files: files.sort(), unsafeLinks: unsafeLinks.sort() };
}

function checkRuntime() {
  const manifestPath = path.join(PLUGIN_ROOT, 'runtime-manifest.json');
  let runtimeStat;
  try { runtimeStat = fs.lstatSync(RUNTIME_ROOT); } catch { runtimeStat = null; }
  if (!runtimeStat || !runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    return {
      ok: false,
      files: 0,
      missing: [],
      mismatches: [],
      extras: [],
      unsafeLinks: ['.']
    };
  }
  let manifest;
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error('unsafe runtime manifest');
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {
      ok: false,
      files: 0,
      missing: ['runtime-manifest.json'],
      mismatches: [],
      extras: [],
      unsafeLinks: []
    };
  }
  if (!Array.isArray(manifest.files)) {
    return {
      ok: false,
      files: 0,
      missing: [],
      mismatches: ['invalid runtime manifest'],
      extras: [],
      unsafeLinks: []
    };
  }

  const expected = new Map();
  const mismatches = [];
  for (const entry of manifest.files) {
    if (
      !entry ||
      !safeRelative(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      expected.has(entry.path)
    ) {
      mismatches.push(String(entry?.path || 'invalid manifest entry'));
      continue;
    }
    expected.set(entry.path, entry.sha256);
  }

  const missing = [];
  for (const [relative, digest] of expected) {
    const file = path.join(RUNTIME_ROOT, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      missing.push(relative);
    } else if (sha256(file) !== digest) {
      mismatches.push(relative);
    }
  }
  const actual = filesUnder(RUNTIME_ROOT);
  const extras = actual.files.filter(relative => !expected.has(relative));
  return {
    ok: missing.length === 0 &&
      mismatches.length === 0 &&
      extras.length === 0 &&
      actual.unsafeLinks.length === 0,
    files: expected.size,
    missing,
    mismatches,
    extras,
    unsafeLinks: actual.unsafeLinks
  };
}

function checkData() {
  let root;
  try { root = fs.lstatSync(BRAIN_DIR); } catch { root = null; }
  if (!root || !root.isDirectory() || root.isSymbolicLink()) {
    return {
      ok: false,
      exists: false,
      missing: REQUIRED_DATA_FILES.slice(),
      insecureModes: [],
      unsafePaths: ['.']
    };
  }

  const missing = [];
  const insecureModes = [];
  const unsafePaths = [];
  for (const relative of REQUIRED_DATA_FILES) {
    const segments = relative.split('/');
    let current = BRAIN_DIR;
    let unsafe = false;
    for (let index = 0; index < segments.length; index++) {
      current = path.join(current, segments[index]);
      let stat;
      try { stat = fs.lstatSync(current); } catch { stat = null; }
      const isFinal = index === segments.length - 1;
      if (!stat) {
        missing.push(relative);
        unsafe = true;
        break;
      }
      if (
        stat.isSymbolicLink() ||
        (isFinal ? !stat.isFile() : !stat.isDirectory())
      ) {
        unsafePaths.push(path.relative(BRAIN_DIR, current) || '.');
        unsafe = true;
        break;
      }
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        insecureModes.push(path.relative(BRAIN_DIR, current) || '.');
      }
    }
    if (unsafe) continue;
  }
  if (process.platform !== 'win32' && (root.mode & 0o077) !== 0) {
    insecureModes.push('.');
  }
  return {
    ok: missing.length === 0 && insecureModes.length === 0 && unsafePaths.length === 0,
    exists: true,
    missing: [...new Set(missing)],
    insecureModes: [...new Set(insecureModes)],
    unsafePaths: [...new Set(unsafePaths)]
  };
}

function checkHooks() {
  const hooksPath = path.join(PLUGIN_ROOT, 'hooks/hooks.json');
  const routerPath = path.join(PLUGIN_ROOT, 'scripts/codex-hook-router.js');
  let document;
  try {
    const hooksStat = fs.lstatSync(hooksPath);
    if (!hooksStat.isFile() || hooksStat.isSymbolicLink()) {
      throw new Error('unsafe hooks file');
    }
    document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  } catch {
    let routerExists = false;
    try {
      const stat = fs.lstatSync(routerPath);
      routerExists = stat.isFile() && !stat.isSymbolicLink();
    } catch {}
    return {
      ok: false,
      missingEvents: REQUIRED_HOOK_EVENTS.slice(),
      invalidEvents: [],
      unexpectedEvents: [],
      routerExists
    };
  }
  const hooks = document && document.hooks;
  const missingEvents = REQUIRED_HOOK_EVENTS.filter(event => !Array.isArray(hooks?.[event]));
  const unexpectedEvents = hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? Object.keys(hooks).filter(event => !Object.hasOwn(HOOK_CONTRACT, event))
    : [];
  const invalidEvents = [];
  for (const [event, expected] of Object.entries(HOOK_CONTRACT)) {
    const groups = hooks?.[event];
    if (!Array.isArray(groups) || groups.length !== 1) {
      invalidEvents.push(event);
      continue;
    }
    const group = groups[0];
    const commands = Array.isArray(group?.hooks) ? group.hooks : [];
    const hook = commands.length === 1 ? commands[0] : null;
    const command = typeof hook?.command === 'string' ? hook.command : '';
    const expectedCommand =
      `node "\${PLUGIN_ROOT}/scripts/codex-hook-router.js" ${expected.mode}`;
    const expectedMatcher = Object.hasOwn(expected, 'matcher')
      ? expected.matcher
      : undefined;
    if (
      !hook ||
      hook.type !== 'command' ||
      command !== expectedCommand ||
      hook.timeout !== expected.timeout ||
      group.matcher !== expectedMatcher
    ) {
      invalidEvents.push(event);
    }
  }
  let routerExists = false;
  try {
    const stat = fs.lstatSync(routerPath);
    routerExists = stat.isFile() && !stat.isSymbolicLink();
  } catch {}
  return {
    ok: missingEvents.length === 0 &&
      invalidEvents.length === 0 &&
      unexpectedEvents.length === 0 &&
      routerExists &&
      REQUIRED_HOOK_EVENTS.length === Object.keys(HOOK_CONTRACT).length,
    missingEvents,
    invalidEvents,
    unexpectedEvents,
    routerExists,
    routerCommands: REQUIRED_HOOK_EVENTS.length - invalidEvents.length,
    failureSignal: 'inferred from PostToolUse tool_response'
  };
}

function readConfig() {
  try {
    const file = path.join(BRAIN_DIR, 'config.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function healthUrl(config) {
  if (process.env.QMD_DAEMON_URL) {
    return new URL('/health', process.env.QMD_DAEMON_URL).toString();
  }
  const port = Number(config.qmd_daemon_port) || 18765;
  return `http://127.0.0.1:${port}/health`;
}

function requestHealth(url, timeoutMs = 1500) {
  return new Promise(resolve => {
    let target;
    try { target = new URL(url); } catch {
      resolve({ ok: false, status: 'invalid_url' });
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    if (!['http:', 'https:'].includes(target.protocol)) {
      resolve({ ok: false, status: 'unsupported_protocol' });
      return;
    }
    let settled = false;
    let request = null;
    let responseStream = null;
    let deadline = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };
    const abort = status => {
      if (settled) return;
      finish({ ok: false, status });
      if (responseStream && !responseStream.destroyed) responseStream.destroy();
      if (request && !request.destroyed) request.destroy();
    };
    request = client.get(target, response => {
      responseStream = response;
      let body = '';
      let bodyBytes = 0;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        bodyBytes += Buffer.byteLength(chunk, 'utf8');
        if (bodyBytes > 64 * 1024) {
          abort('response_too_large');
          return;
        }
        body += chunk;
      });
      response.on('aborted', () => finish({ ok: false, status: 'aborted' }));
      response.on('error', () => finish({ ok: false, status: 'response_error' }));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish({ ok: false, status: `http_${response.statusCode}` });
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}');
          const healthy = parsed.ok === true ||
            ['ok', 'healthy'].includes(String(parsed.status || '').toLowerCase());
          finish({ ok: healthy, status: healthy ? 'healthy' : 'unhealthy' });
        } catch {
          finish({ ok: false, status: 'invalid_json' });
        }
      });
    });
    request.on('error', () => finish({ ok: false, status: 'unreachable' }));
    deadline = setTimeout(() => abort('timeout'), timeoutMs);
  });
}

async function checkQmd(config, dataOk) {
  if (!config || !dataOk) {
    return { ok: false, enabled: null, status: 'configuration_unavailable' };
  }
  if (config.qmd_enabled !== true) {
    return { ok: true, enabled: false, status: 'disabled' };
  }
  const timeoutMs = Math.min(
    Math.max(Number(config.qmd_fast_timeout_ms) || 1500, 100),
    5000
  );
  const health = await requestHealth(healthUrl(config), timeoutMs);
  return { ...health, enabled: true, port: Number(config.qmd_daemon_port) || 18765 };
}

async function main() {
  const report = {
    status: 'ok',
    version: '8.3.1',
    node: process.version,
    brainDir: BRAIN_DIR,
    readOnly: true,
    checks: {}
  };
  report.checks.data = checkData();
  report.checks.runtime = checkRuntime();
  report.checks.hooks = checkHooks();
  const config = readConfig();
  report.checks.qmd = await checkQmd(config, report.checks.data.ok);
  if (Object.values(report.checks).some(check => check.ok !== true)) {
    report.status = 'error';
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'ok' ? 0 : 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      version: '8.3.1',
      readOnly: true,
      checks: {},
      error: 'doctor_internal_error'
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  requestHealth
};
