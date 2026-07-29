#!/usr/bin/env node
// smell-check.js — Claude Brain · Shitcode Red-Light · PostToolUse hook
//
// Mount: settings.json PostToolUse / matcher "Write|Edit|MultiEdit"
// Timing: the MOMENT you finish writing / editing a source file — exactly when
//         shitcode actually accumulates. Before-the-fact (a pre-prompt reminder) is
//         too early; after-the-fact (a session-end audit) is too late. This fills the gap.
//
// Input:  stdin JSON { tool_name, tool_input.file_path }
// Output: soft red light → { hookSpecificOutput:{ hookEventName:'PostToolUse', additionalContext } }
//         (injected, NOT blocking).  Nothing to report → silent exit 0.
//
// Why soft, never decision:block — a PostToolUse block does NOT roll back the file
// and triggers a "block → retry → block" infinite loop. Even secrets are soft-injected
// here. Hard blocking is left to a future PreToolUse hook (fires before the write).
//
// Iron rule: ALWAYS exit 0. Any exception exits silently. NEVER block the main flow.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Brain home — override with env BRAIN_DIR if you keep config elsewhere.
const BRAIN_DIR = process.env.BRAIN_DIR || path.join(os.homedir(), '.claude-brain');
const CONFIG_PATH = path.join(BRAIN_DIR, 'config.json');
const THROTTLE_PATH = path.join(BRAIN_DIR, 'state/throttle.json');

let detectors;
try {
  detectors = require('./detectors.js');
} catch {
  process.exit(0);
}

const DEFAULT_CONFIG = {
  enabled: false,
  file_too_long: { hard_max: 800, warn: 500 },
  long_block_lines: 80,
  todo_pileup_threshold: 5,
  dead_code_min_lines: 6,
  dead_code_header_skip: 10,
  debug_leftover_min: 2,
  throttle_minutes: 15,
  max_findings_shown: 2,
  max_file_bytes: 524288,
  source_exts: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.go',
    '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php',
    '.swift', '.vue', '.svelte', '.sh', '.bash', '.scala'],
  // Generated / vendored / build output should not be linted line-by-line.
  // '.claude-brain' exempts the tool's own install dir (its detector source legitimately
  // contains TODO/secret keywords + test fixtures — don't flag the tool by the tool).
  // Add your own private paths (notes, journals, memory stores) in config.json.
  skip_path_patterns: ['node_modules', '/dist/', '/build/', '.git/', '__pycache__',
    '/vendor/', '/.next/', '/target/', '/coverage/', '.min.js', '.claude-brain'],
};

const SEV = { high: 3, mid: 2, low: 1 };

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Atomic write: temp file + rename, so concurrent sessions can't corrupt throttle.json
function writeAtomic(p, content) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

// Gate: only inspect source files; skip docs/config/data/deps/private paths
function gate(filePath, cfg) {
  const resolved = path.resolve(filePath);
  const lower = resolved.toLowerCase();
  for (const pat of cfg.skip_path_patterns) {
    if (lower.includes(pat.toLowerCase())) return null;
  }
  const ext = path.extname(lower);
  if (!cfg.source_exts.includes(ext)) return null;
  return { resolved, ext };
}

function isThrottled(filePath, cfg) {
  try {
    const data = JSON.parse(fs.readFileSync(THROTTLE_PATH, 'utf-8'));
    const last = data[filePath];
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) / 60000 < cfg.throttle_minutes;
  } catch {
    return false;
  }
}

function recordNotify(filePath) {
  try {
    fs.mkdirSync(path.dirname(THROTTLE_PATH), { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(THROTTLE_PATH, 'utf-8')); } catch {}
    const now = Date.now();
    const fresh = {};
    for (const [k, v] of Object.entries(data)) {
      if ((now - new Date(v).getTime()) / 86400000 < 1) fresh[k] = v;
    }
    fresh[filePath] = new Date().toISOString();
    writeAtomic(THROTTLE_PATH, JSON.stringify(fresh, null, 2));
  } catch {}
}

// Narrow: only recognize explicit test conventions — foo.test.js / foo_test.go /
// test_foo.py / tests|__tests__ dirs. No loose '_test' infix, so a business file like
// latest_test_results.js is not misjudged as a test and silently skipped.
function isTestFile(resolved) {
  const l = resolved.toLowerCase();
  return /(\.|_)(test|spec)\.[a-z0-9]+$|\/(tests?|__tests__)\/|(^|\/)test_[^/]*\.[a-z0-9]+$/.test(l);
}

// Anti-flood: show only the 1–2 heaviest findings; summarize the rest in one line
function render(findings, filePath, cfg) {
  const sorted = [...findings].sort((a, b) => SEV[b.severity] - SEV[a.severity]);
  const shown = sorted.slice(0, cfg.max_findings_shown);
  const rest = sorted.length - shown.length;

  let rel = path.relative(os.homedir(), filePath);
  rel = rel.startsWith('..') ? filePath : '~/' + rel;

  const body = ['🚩 Shitcode Red-Light · ' + rel, ''];
  shown.forEach((f, i) => {
    body.push(`${i + 1}. ${f.title}`);
    body.push(`   ${f.prompt}`);
  });
  if (rest > 0) body.push(`(+${rest} more minor — not interrupting you for those)`);
  body.push('');
  body.push("— This light doesn't block you. It just keeps you from cutting a corner silently. If it's truly fine, say so in one line and move on.");

  return body.join('\n');
}

function main(raw) {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  const payload = JSON.parse(raw || '{}');
  if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name || '')) return;

  const filePath = payload.tool_input && payload.tool_input.file_path;
  if (!filePath) return;

  const g = gate(filePath, cfg);
  if (!g) return;
  if (isThrottled(g.resolved, cfg)) return;

  // Large-file gate: generated files / bundles shouldn't be linted line-by-line; check size first
  let stat;
  try { stat = fs.statSync(g.resolved); } catch { return; }
  if (stat.size > cfg.max_file_bytes) return;

  let content;
  try { content = fs.readFileSync(g.resolved, 'utf-8'); } catch { return; }
  if (!content || !content.trim()) return;

  const lines = content.split('\n');
  const ctx = {
    content, lines, lineCount: lines.length,
    filePath: g.resolved, ext: g.ext, isTest: isTestFile(g.resolved),
  };

  const findings = detectors.runAll(ctx, cfg);
  if (findings.length === 0) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: render(findings, g.resolved, cfg) },
  }));
  recordNotify(g.resolved);
}

let input = '';
const timer = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(timer);
  try { main(input); } catch { /* silent — never block the main flow */ }
  process.exit(0);
});
