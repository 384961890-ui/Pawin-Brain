#!/usr/bin/env node
// smell-check.js — claude-brain v6 屎山红灯 · PostToolUse hook（加固版 v6.0.1）
//
// 挂载：settings.json PostToolUse / matcher "Write|Edit|MultiEdit"
// 时机：我每写完 / 改完一个源码文件的「那一秒」—— 屎山真正攒出来的时刻。
//       事前(UserPromptSubmit 动手前三问)太早，事后(Stop capture-lesson)太晚，这里补中间。
//
// 输入：stdin JSON { tool_name, tool_input.file_path }
// 输出：软红灯 → { hookSpecificOutput:{ hookEventName:'PostToolUse', additionalContext } }（注入不阻断）
//       无事   → 静默 exit 0
// v6.0.1 起取消 decision:block 硬拦 —— PostToolUse 的 block 不回滚文件且会触发
//         「block→重试→再block」死循环，密钥也改软注入。硬拦留给未来 PreToolUse。
//
// 铁律：永远 exit 0，任何异常静默退出，绝不阻塞主流程。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const V6_DIR = path.join(os.homedir(), '.claude-brain/v6');
const CONFIG_PATH = path.join(V6_DIR, 'config.json');
const THROTTLE_PATH = path.join(V6_DIR, 'state/throttle.json');

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
  throttle_minutes: 5,
  max_findings_shown: 2,
  max_file_bytes: 524288,
  source_exts: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.go',
    '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php',
    '.swift', '.vue', '.svelte', '.sh', '.bash', '.scala'],
  skip_path_patterns: ['node_modules', '/dist/', '/build/', '.git/', '__pycache__',
    '/vendor/', '/.next/', '/target/', '/coverage/', '.min.js',
    '/.claude/projects/', '/.claude/diary/',
    '/.claude-brain/lessons/'],
};

const SEV = { high: 3, mid: 2, low: 1 };

function loadConfig() {
  try {
    return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
  } catch {
    return DEFAULT_CONFIG;
  }
}

// 原子写：临时文件 + rename，避免多 session 并发写 throttle.json 损坏
function writeAtomic(p, content) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

// 门禁：只查源码文件，跳过文档/配置/数据/依赖/记忆/日记
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

// 收窄：只认明确测试约定 —— foo.test.js / foo_test.go / test_foo.py / tests|__tests__ 目录。
// 不再用宽松 '_test' 中缀，避免 latest_test_results.js 这类业务文件被误判成测试而漏检。
function isTestFile(resolved) {
  const l = resolved.toLowerCase();
  return /(\.|_)(test|spec)\.[a-z0-9]+$|\/(tests?|__tests__)\/|(^|\/)test_[^/]*\.[a-z0-9]+$/.test(l);
}

// 防淹：只摆最重 1~2 条，其余汇总成一句
function render(findings, filePath, cfg) {
  const sorted = [...findings].sort((a, b) => SEV[b.severity] - SEV[a.severity]);
  const shown = sorted.slice(0, cfg.max_findings_shown);
  const rest = sorted.length - shown.length;

  let rel = path.relative(os.homedir(), filePath);
  rel = rel.startsWith('..') ? filePath : '~/' + rel;

  const body = ['🚩 屎山红灯 · ' + rel, ''];
  shown.forEach((f, i) => {
    body.push(`${i + 1}. ${f.title}`);
    body.push(`   ${f.prompt}`);
  });
  if (rest > 0) body.push(`（还有 ${rest} 处小问题，先不打断你）`);
  body.push('');
  body.push('— 这盏灯不拦你，只逼你别「默默图省事」。真该这样就一句话说清，然后继续。');

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

  // 大文件门禁：生成文件/打包产物不该逐行 lint，先看大小避免读爆/拖慢 hook
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
  try { main(input); } catch { /* 静默 — 绝不阻塞主流程 */ }
  process.exit(0);
});
