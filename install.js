#!/usr/bin/env node
'use strict';

// Compatibility entry point for the original v6 installer name. Installing a
// single historical hook leaves Brain half-wired, so all legacy entry points
// now delegate to the complete, tested Claude Code installer.

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const installer = path.join(__dirname, 'install-claude-hooks.js');
const brainDir = process.env.CLAUDE_BRAIN_DIR ||
  process.env.BRAIN_DIR ||
  path.join(os.homedir(), '.claude-brain');
const result = spawnSync(process.execPath, [installer, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CLAUDE_BRAIN_DIR: brainDir }
});
if (result.error) {
  process.stderr.write('Pawin-Brain compatibility installer failed to start\n');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
