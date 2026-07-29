#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootstrap, BRAIN_DIR, PLUGIN_ROOT } = require('./bootstrap-runtime.js');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function checkRuntime() {
  const manifestPath = path.join(PLUGIN_ROOT, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mismatches = [];
  for (const entry of manifest.files) {
    const file = path.join(PLUGIN_ROOT, 'runtime', entry.path);
    if (!fs.existsSync(file) || sha256(file) !== entry.sha256) mismatches.push(entry.path);
  }
  return { files: manifest.files.length, mismatches };
}

function main() {
  const report = {
    status: 'ok',
    version: '8.3.0',
    node: process.version,
    brainDir: BRAIN_DIR,
    checks: {}
  };
  try {
    const boot = bootstrap();
    report.checks.bootstrap = { ok: true, created: boot.created };
    const runtime = checkRuntime();
    report.checks.runtime = { ok: runtime.mismatches.length === 0, ...runtime };
    report.checks.hooks = {
      ok: fs.existsSync(path.join(PLUGIN_ROOT, 'hooks/hooks.json')),
      events: [
        'SessionStart',
        'UserPromptSubmit',
        'PostToolUse',
        'Stop'
      ],
      failureSignal: 'inferred from PostToolUse tool_response'
    };
    const config = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, 'config.json'), 'utf8'));
    report.checks.qmd = {
      ok: true,
      enabled: config.qmd_enabled === true,
      port: config.qmd_daemon_port || 18765
    };
    if (!report.checks.runtime.ok || !report.checks.hooks.ok) report.status = 'error';
  } catch (error) {
    report.status = 'error';
    report.error = error.message;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'ok' ? 0 : 1;
}

main();
