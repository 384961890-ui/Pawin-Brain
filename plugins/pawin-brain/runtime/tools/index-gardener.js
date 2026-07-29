#!/usr/bin/env node
'use strict';

/**
 * index-gardener.js — 索引园丁
 *
 * 纯确定性夜间巡检脚本，不调用任何 LLM。检查记忆库（memory/）里的
 * .md 文件是否都被其目录链上的 INDEX.md / 根 MEMORY.md 引用过，
 * 并标出 90 天未核实的文件、以及自上次运行以来的变更。
 *
 * 只读报告工具：绝不修改/删除/移动任何记忆文件。
 *
 * 灵感来自 LangChain OpenWiki 的 diff 驱动 wiki 维护。
 *
 * 用法：node index-gardener.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 路径常量 ----------
// 环境变量优先；否则用默认约定路径（不含硬编码用户名）。
// MEMORY_ROOT 依赖 Claude Code 的 projects/-<escaped-home>/ 命名约定；
// 部署时可用 CLAUDE_MEMORY_ROOT 覆盖成任意路径。

const HOME = os.homedir();
const BRAIN_DIR = process.env.CLAUDE_BRAIN_DIR || path.join(HOME, '.claude-brain');
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(HOME, '.claude');
const MEMORY_ROOT = process.env.CLAUDE_MEMORY_ROOT ||
  path.join(CLAUDE_DIR, 'projects', `-${HOME.replace(/\//g, '-')}`, 'memory');
const STATE_DIR = path.join(BRAIN_DIR, 'state');
const STATE_FILE = path.join(STATE_DIR, 'index-gardener.json');
const REPORT_FILE = path.join(STATE_DIR, 'index-gardener-last-report.md');
const DIARY_DIR = process.env.CLAUDE_DIARY_DIR || path.join(CLAUDE_DIR, 'diary');

// 部署时可用环境变量覆盖，逗号分隔；默认覆盖常见 memory/ 顶层目录。
const SCAN_DIRS = (process.env.CLAUDE_GARDENER_SCAN_DIRS || 'projects,partners,feedback,reference,user')
  .split(',').map(s => s.trim()).filter(Boolean);
const STALE_CHECK_DIRS = (process.env.CLAUDE_GARDENER_STALE_DIRS || 'projects,partners,reference')
  .split(',').map(s => s.trim()).filter(Boolean);
const EXCLUDE_PATH_SEGMENTS = (process.env.CLAUDE_GARDENER_EXCLUDE || '_archive,memory-snapshots,vault,.bak')
  .split(',').map(s => s.trim()).filter(Boolean);
const STALE_DAYS = 90;
const STALE_MAX_LIST = 20;
const RECENT_MAX_LIST = 50; // 昨日变更节展示上限（防御性上限，通常不会触发）

// ---------- 工具函数 ----------

function nowISO() {
  return new Date().toISOString();
}

function todayDateStr() {
  // 本地日期 YYYY-MM-DD
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nowHHMM() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function isExcludedPath(relPath) {
  const segments = relPath.split(path.sep);
  if (segments.some((seg) => EXCLUDE_PATH_SEGMENTS.includes(seg))) return true;
  if (path.basename(relPath) === 'INDEX.md') return true;
  return false;
}

/** 递归列出 dir（绝对路径）下所有 .md 文件，返回相对于 MEMORY_ROOT 的路径数组 */
function walkMdFiles(absDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(MEMORY_ROOT, abs);
    if (isExcludedForWalk(rel)) continue;
    if (entry.isDirectory()) {
      results.push(...walkMdFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(rel);
    }
  }
  return results;
}

function isExcludedForWalk(relPath) {
  const segments = relPath.split(path.sep);
  return segments.some((seg) => EXCLUDE_PATH_SEGMENTS.includes(seg));
}

/** 找到相对路径 relFile 的祖先目录链上所有 INDEX.md（绝对路径），从最近到最远（不含根） */
function ancestorIndexFiles(relFile) {
  const found = [];
  let dir = path.dirname(path.join(MEMORY_ROOT, relFile));
  while (true) {
    const rel = path.relative(MEMORY_ROOT, dir);
    // 到达 MEMORY_ROOT 本身时停止（根 MEMORY.md 单独处理）
    if (rel === '' || rel === '.') break;
    const candidate = path.join(dir, 'INDEX.md');
    if (fs.existsSync(candidate)) {
      found.push(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** 返回离 relFile 最近的 INDEX.md 路径（若无任何祖先 INDEX.md，退回根 MEMORY.md） */
function nearestIndexFile(relFile) {
  const chain = ancestorIndexFiles(relFile);
  if (chain.length > 0) return chain[0];
  return path.join(MEMORY_ROOT, 'MEMORY.md');
}

/** 检查文件是否在给定的一批"索引文件"文本内容里被引用（basename 含或不含 .md 后缀出现即算） */
function isReferenced(relFile, indexFiles) {
  const base = path.basename(relFile); // e.g. foo.md
  const baseNoExt = base.slice(0, -3); // e.g. foo
  for (const idxPath of indexFiles) {
    let text;
    try {
      text = fs.readFileSync(idxPath, 'utf8');
    } catch (err) {
      continue;
    }
    if (text.includes(base) || text.includes(baseNoExt)) return true;
  }
  return false;
}

/** 解析 frontmatter 里的 last-verified: YYYY-MM-DD（若存在），返回 Date 或 null */
function parseFrontmatterLastVerified(absPath) {
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return null;
  }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(0, end);
  const m = fm.match(/last-verified:\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(m[1] + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d;
}

/** git log -1 --format=%ct 的提交时间（秒），失败返回 null */
function gitLastCommitTime(absPath) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', '--', absPath],
      { cwd: MEMORY_ROOT, encoding: 'utf8' }
    ).trim();
    if (!out) return null;
    return new Date(parseInt(out, 10) * 1000);
  } catch (err) {
    return null;
  }
}

function fsMtime(absPath) {
  try {
    return fs.statSync(absPath).mtime;
  } catch (err) {
    return null;
  }
}

/** 获取文件的"最后核实时间"，按优先级：frontmatter > git > fs mtime */
function lastVerifiedDate(relFile) {
  const abs = path.join(MEMORY_ROOT, relFile);
  const fm = parseFrontmatterLastVerified(abs);
  if (fm) return { date: fm, source: 'frontmatter' };
  const git = gitLastCommitTime(abs);
  if (git) return { date: git, source: 'git' };
  const mt = fsMtime(abs);
  if (mt) return { date: mt, source: 'mtime' };
  return { date: null, source: 'unknown' };
}

function daysSince(date) {
  const ms = Date.now() - date.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function fmtDate(date) {
  if (!date) return '未知';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function gitCurrentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: MEMORY_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    return null;
  }
}

function gitDiffNameOnly(fromCommit, toCommit) {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', fromCommit, toCommit],
      { cwd: MEMORY_ROOT, encoding: 'utf8' }
    );
    return out.split('\n').filter(Boolean);
  } catch (err) {
    return null; // 上次的 commit 可能已经不存在（history rewrite）等异常情况
  }
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function ensureDiaryAppend(section) {
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  const diaryPath = path.join(DIARY_DIR, `${todayDateStr()}.md`);
  if (!fs.existsSync(diaryPath)) {
    fs.writeFileSync(diaryPath, `# ${todayDateStr()}\n`, 'utf8');
  }
  fs.appendFileSync(diaryPath, `\n${section}\n`, 'utf8');
}

// ---------- 主逻辑 ----------

function main() {
  const allMdFiles = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(MEMORY_ROOT, d);
    if (!fs.existsSync(abs)) continue;
    allMdFiles.push(...walkMdFiles(abs));
  }
  allMdFiles.sort();

  // 检查 1：孤儿
  const orphans = [];
  for (const relFile of allMdFiles) {
    const chain = ancestorIndexFiles(relFile);
    const rootMemory = path.join(MEMORY_ROOT, 'MEMORY.md');
    const indexFiles = [...chain, rootMemory];
    if (!isReferenced(relFile, indexFiles)) {
      orphans.push({
        relFile,
        suggestedIndex: path.relative(MEMORY_ROOT, nearestIndexFile(relFile)),
      });
    }
  }

  // 检查 2：过期未核实（只查 projects/(非archive) partners/ reference/）
  const staleCandidates = [];
  for (const relFile of allMdFiles) {
    const topDir = relFile.split(path.sep)[0];
    if (!STALE_CHECK_DIRS.includes(topDir)) continue;
    const { date, source } = lastVerifiedDate(relFile);
    if (!date) continue;
    const age = daysSince(date);
    if (age > STALE_DAYS) {
      staleCandidates.push({ relFile, date, source, age });
    }
  }
  staleCandidates.sort((a, b) => a.date.getTime() - b.date.getTime()); // 最旧优先
  const staleTotal = staleCandidates.length;
  const staleShown = staleCandidates.slice(0, STALE_MAX_LIST);
  const staleExtra = staleTotal - staleShown.length;

  // 检查 3：昨日变更（依赖上次运行状态）
  const prevState = loadState();
  const currentHead = gitCurrentHead();
  let recentChanges = null; // null = 跳过（首次运行）
  if (prevState && prevState.lastCommit && currentHead) {
    if (prevState.lastCommit === currentHead) {
      recentChanges = []; // 没有新提交
    } else {
      const diffFiles = gitDiffNameOnly(prevState.lastCommit, currentHead);
      if (diffFiles !== null) {
        const scanned = diffFiles.filter((f) => {
          if (!f.endsWith('.md')) return false;
          const topDir = f.split('/')[0];
          if (!SCAN_DIRS.includes(topDir)) return false;
          if (isExcludedPath(f)) return false;
          return true;
        });
        recentChanges = scanned.map((relFile) => {
          const chain = ancestorIndexFiles(relFile);
          const rootMemory = path.join(MEMORY_ROOT, 'MEMORY.md');
          const indexFiles = [...chain, rootMemory];
          const indexed = fs.existsSync(path.join(MEMORY_ROOT, relFile))
            ? isReferenced(relFile, indexFiles)
            : null; // 文件在 diff 里但已被删除/移动，不判定
          return { relFile, indexed };
        });
      }
    }
  }

  // ---------- 写报告 ----------
  const lines = [];
  lines.push(`# 索引园丁报告`);
  lines.push('');
  lines.push(`运行时间：${nowISO()}`);
  lines.push(`扫描文件总数：${allMdFiles.length}（范围：${SCAN_DIRS.join(' ')}）`);
  lines.push('');

  lines.push(`## 检查 1 · 孤儿文件（${orphans.length} 件）`);
  lines.push('');
  if (orphans.length === 0) {
    lines.push('无孤儿。');
  } else {
    for (const o of orphans) {
      lines.push(`- \`${o.relFile}\` → 建议入册 \`${o.suggestedIndex}\``);
    }
  }
  lines.push('');

  lines.push(`## 检查 2 · 过期未核实 >${STALE_DAYS} 天（共 ${staleTotal} 件，列前 ${staleShown.length} 条）`);
  lines.push('');
  if (staleTotal === 0) {
    lines.push('无。');
  } else {
    for (const s of staleShown) {
      lines.push(`- \`${s.relFile}\`（最后核实 ${fmtDate(s.date)}，来源=${s.source}，已 ${s.age} 天）`);
    }
    if (staleExtra > 0) {
      lines.push(`（另有 ${staleExtra} 条，详见完整扫描）`);
    }
  }
  lines.push('');

  lines.push(`## 检查 3 · 自上次运行以来的变更`);
  lines.push('');
  if (recentChanges === null) {
    lines.push('首次运行，无历史基线，跳过本节。');
  } else if (recentChanges.length === 0) {
    lines.push('无新变更。');
  } else {
    const shown = recentChanges.slice(0, RECENT_MAX_LIST);
    for (const c of shown) {
      const tag = c.indexed === null ? '（已删除/移动）' : c.indexed ? '（已入册）' : '（未入册）';
      lines.push(`- \`${c.relFile}\` ${tag}`);
    }
    if (recentChanges.length > shown.length) {
      lines.push(`（另有 ${recentChanges.length - shown.length} 条）`);
    }
  }
  lines.push('');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');

  // ---------- 更新状态 ----------
  // 发现指纹：同样的发现一天只进一次日记（治 7/05 上午连刷三次的毛病）
  const crypto = require('crypto');
  const findingsFingerprint = crypto.createHash('sha1')
    .update(JSON.stringify({ o: orphans.map((x) => x.relFile), s: staleTotal, d: todayDateStr() }))
    .digest('hex');
  const prevFingerprint = loadState() ? loadState().findingsFingerprint : null;

  saveState({
    lastRunISO: nowISO(),
    lastCommit: currentHead,
    findingsFingerprint,
  });

  // ---------- 日记 append（仅在有发现时） ----------
  const uncatalogedRecent = recentChanges
    ? recentChanges.filter((c) => c.indexed === false)
    : [];
  const hasFindings = orphans.length > 0 || staleTotal > 0 || uncatalogedRecent.length > 0;

  if (hasFindings && findingsFingerprint !== prevFingerprint) {
    const diaryLines = [];
    diaryLines.push(`### 🌿 索引园丁（自动 · ${nowHHMM()}）`);
    if (orphans.length > 0) {
      diaryLines.push(`- 孤儿 ${orphans.length} 件：`);
      for (const o of orphans) {
        diaryLines.push(`  - \`${o.relFile}\` → 建议入册 \`${o.suggestedIndex}\``);
      }
    } else {
      diaryLines.push(`- 孤儿 0 件`);
    }
    diaryLines.push(`- 过期未核实 ${staleTotal} 件（>${STALE_DAYS}天）` + (staleTotal > 0 ? '：' : ''));
    if (staleTotal > 0) {
      for (const s of staleShown.slice(0, 5)) {
        diaryLines.push(`  - \`${s.relFile}\`（最后核实 ${fmtDate(s.date)}）`);
      }
      if (staleTotal > 5) diaryLines.push(`  - （另有 ${staleTotal - 5} 条，详见报告）`);
    }
    const recentCount = recentChanges ? recentChanges.length : 0;
    diaryLines.push(`- 昨日变更 ${recentCount} 件 其中未入册 ${uncatalogedRecent.length} 件`);
    diaryLines.push(`（详单见 state/index-gardener-last-report.md）`);
    ensureDiaryAppend(diaryLines.join('\n'));
  }

  // 控制台输出（供手动运行时查看）
  console.log(`扫描文件总数：${allMdFiles.length}`);
  console.log(`孤儿：${orphans.length}`);
  console.log(`过期未核实（>${STALE_DAYS}天）：${staleTotal}`);
  console.log(`昨日变更：${recentChanges === null ? '跳过（首次运行）' : recentChanges.length}`);
  console.log(`报告文件：${REPORT_FILE}`);
  console.log(`日记：${hasFindings ? '已 append' : '无发现，未动'}`);
}

try {
  main();
} catch (err) {
  const msg = (err && err.stack) || String(err);
  console.error('index-gardener 崩溃：', msg);
  try {
    ensureDiaryAppend(`### 🌿 索引园丁运行失败：${String((err && err.message) || err).slice(0, 300)}`);
  } catch (diaryErr) {
    console.error('连写日记失败行都写不进去：', diaryErr);
  }
  process.exitCode = 1;
}
