#!/usr/bin/env node
'use strict';

/**
 * index-gardener.js — nightly memory-tree audit.
 *
 * Purely deterministic, read-only report tool — no LLM calls, and it never
 * modifies, moves, or deletes any memory file (see LESSONS-LEARNED.md #5).
 * It checks a memory tree for:
 *
 *   1. Orphans — leaf .md files not referenced by any ancestor INDEX.md
 *      (or the root MEMORY.md). Content nobody can reach through the
 *      index tree, only through luck via full-text/embedding search.
 *   2. Staleness — files whose `last-verified` (or, failing that, git
 *      last-commit or filesystem mtime) is older than a threshold.
 *   3. Since-last-run diff — if the tree is under git, which files changed
 *      since the previous run and whether they're indexed.
 *
 * It writes a report file and, only when there's something new to report
 * (deduped by a content fingerprint so the same finding doesn't spam a log
 * every run), can append a summary to a daily log file.
 *
 * Env vars (all optional, sensible generic defaults):
 *   MEMORY_DIR        — root of the memory tree (default: ~/memory)
 *   GARDENER_STATE_DIR — where to keep run-state + report (default: MEMORY_DIR/.gardener-state)
 *   LOG_DIR             — directory for a daily log file to append findings to
 *                          (default: unset — logging step is skipped)
 *   SCAN_DIRS           — comma-separated list of top-level dirs to scan
 *                          (default: projects,partners,feedback,reference,user,lessons)
 *   STALE_CHECK_DIRS    — comma-separated subset of SCAN_DIRS to run the
 *                          staleness check on (default: projects,partners,reference)
 *   STALE_DAYS          — staleness threshold in days (default: 90)
 *
 * Usage: node index-gardener.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MEMORY_ROOT = process.env.MEMORY_DIR || path.join(os.homedir(), 'memory');
const STATE_DIR = process.env.GARDENER_STATE_DIR || path.join(MEMORY_ROOT, '.gardener-state');
const STATE_FILE = path.join(STATE_DIR, 'index-gardener.json');
const REPORT_FILE = path.join(STATE_DIR, 'index-gardener-last-report.md');
const LOG_DIR = process.env.LOG_DIR || null;

const SCAN_DIRS = (process.env.SCAN_DIRS || 'projects,partners,feedback,reference,user,lessons')
  .split(',').map((s) => s.trim()).filter(Boolean);
const STALE_CHECK_DIRS = (process.env.STALE_CHECK_DIRS || 'projects,partners,reference')
  .split(',').map((s) => s.trim()).filter(Boolean);
const EXCLUDE_PATH_SEGMENTS = ['_archive', '.bak'];
const STALE_DAYS_PARSED = parseInt(process.env.STALE_DAYS || '90', 10);
// A garbled override (e.g. STALE_DAYS=abc) must not silently disable the
// entire staleness check by turning every comparison into `age > NaN`
// (always false) — fall back to the documented default instead.
const STALE_DAYS = Number.isNaN(STALE_DAYS_PARSED) ? 90 : STALE_DAYS_PARSED;
const STALE_MAX_LIST = 20;
const RECENT_MAX_LIST = 50;

// ---------- utilities ----------

function nowISO() { return new Date().toISOString(); }

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isExcludedForWalk(relPath) {
  const segments = relPath.split(path.sep);
  return segments.some((seg) => EXCLUDE_PATH_SEGMENTS.includes(seg));
}

/** Recursively list all .md files under absDir, relative to MEMORY_ROOT. */
function walkMdFiles(absDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(MEMORY_ROOT, abs);
    if (isExcludedForWalk(rel)) continue;
    if (entry.isDirectory()) {
      results.push(...walkMdFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      results.push(rel);
    }
  }
  return results;
}

/** All ancestor INDEX.md files for relFile, nearest first (excludes root). */
function ancestorIndexFiles(relFile) {
  const found = [];
  let dir = path.dirname(path.join(MEMORY_ROOT, relFile));
  while (true) {
    const rel = path.relative(MEMORY_ROOT, dir);
    if (rel === '' || rel === '.') break;
    const candidate = path.join(dir, 'INDEX.md');
    if (fs.existsSync(candidate)) found.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function nearestIndexFile(relFile) {
  const chain = ancestorIndexFiles(relFile);
  if (chain.length > 0) return chain[0];
  return path.join(MEMORY_ROOT, 'MEMORY.md');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is relFile referenced by a *structured* link in any of indexFiles —
 * `[[slug]]`, `(slug.md)` (a Markdown link target), `` `slug` `` (inline
 * code), or the bare filename/slug as a whole word? A plain substring
 * search (the previous implementation) false-negatives constantly: a file
 * named `a.md` would be "referenced" by any index containing the English
 * word "and", because "and".includes("a") is true. That silently hides
 * exactly the short/common-word-named files this orphan check exists to
 * catch. Whole-word boundaries (`\b`) prevent that: `\ba\b` matches a
 * standalone "a" but not the "a" inside "and".
 */
function isReferenced(relFile, indexFiles, textCache) {
  const base = path.basename(relFile); // e.g. "a.md"
  const baseNoExt = base.slice(0, -3); // e.g. "a"
  const eBase = escapeRegExp(base);
  const eNoExt = escapeRegExp(baseNoExt);
  const patterns = [
    new RegExp(`\\[\\[${eNoExt}\\]\\]`), // [[slug]] wikilink
    new RegExp(`\\(${eBase}\\)`), // (slug.md) markdown link target
    new RegExp('`' + eNoExt + '`'), // `slug` inline code
    new RegExp(`\\b${eBase}\\b`), // whole-word filename.md
    new RegExp(`\\b${eNoExt}\\b`), // whole-word slug, no extension
  ];
  for (const idxPath of indexFiles) {
    let text;
    if (textCache && textCache.has(idxPath)) {
      text = textCache.get(idxPath);
    } else {
      try { text = fs.readFileSync(idxPath, 'utf8'); } catch { text = null; }
      if (textCache) textCache.set(idxPath, text);
    }
    if (text === null || text === undefined) continue;
    if (patterns.some((re) => re.test(text))) return true;
  }
  return false;
}

function parseFrontmatterLastVerified(absPath) {
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(0, end);
  const m = fm.match(/last-verified:\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const d = new Date(m[1] + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

// Probed once per run and cached — without this, a non-git MEMORY_ROOT
// spawns `git log` (which fails with "fatal: not a git repository") once
// per scanned file, flooding stderr for no benefit on any tree that simply
// isn't under git.
let gitRepoCache = null;
function isGitRepo() {
  if (gitRepoCache !== null) return gitRepoCache;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: MEMORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    gitRepoCache = true;
  } catch {
    gitRepoCache = false;
  }
  return gitRepoCache;
}

function gitLastCommitTime(absPath) {
  if (!isGitRepo()) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', absPath], {
      cwd: MEMORY_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out ? new Date(parseInt(out, 10) * 1000) : null;
  } catch {
    return null;
  }
}

function fsMtime(absPath) {
  try { return fs.statSync(absPath).mtime; } catch { return null; }
}

/** last-verified date for relFile, priority: frontmatter > git > mtime. */
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

function daysSince(date) { return Math.floor((Date.now() - date.getTime()) / 86400000); }

function fmtDate(date) {
  if (!date) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function gitCurrentHead() {
  if (!isGitRepo()) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: MEMORY_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gitDiffNameOnly(fromCommit, toCommit) {
  if (!isGitRepo()) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', fromCommit, toCommit], {
      cwd: MEMORY_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null; // e.g. previous commit no longer reachable (history rewrite)
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Atomic write (tmp + rename), matching this package's write style
  // elsewhere (generate-index.js, full_scan.py) — a kill -9 mid-write must
  // never leave STATE_FILE half-written, since the next run's diff-since-
  // last-run check depends on it being intact JSON.
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function appendLog(section) {
  if (!LOG_DIR) return; // logging is opt-in via env var
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${todayDateStr()}.md`);
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, `# ${todayDateStr()}\n`, 'utf8');
  fs.appendFileSync(logPath, `\n${section}\n`, 'utf8');
}

// ---------- main ----------

function main() {
  const allMdFiles = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(MEMORY_ROOT, d);
    if (!fs.existsSync(abs)) continue;
    allMdFiles.push(...walkMdFiles(abs));
  }
  allMdFiles.sort();

  // Shared across both isReferenced() call sites below — many leaf files
  // share the same ancestor INDEX.md, so without a cache each one gets
  // read from disk again for every file checked against it.
  const indexTextCache = new Map();

  // Check 1: orphans
  const orphans = [];
  for (const relFile of allMdFiles) {
    const chain = ancestorIndexFiles(relFile);
    const rootMemory = path.join(MEMORY_ROOT, 'MEMORY.md');
    const indexFiles = [...chain, rootMemory];
    if (!isReferenced(relFile, indexFiles, indexTextCache)) {
      orphans.push({ relFile, suggestedIndex: path.relative(MEMORY_ROOT, nearestIndexFile(relFile)) });
    }
  }

  // Check 2: stale, unverified
  const staleCandidates = [];
  for (const relFile of allMdFiles) {
    const topDir = relFile.split(path.sep)[0];
    if (!STALE_CHECK_DIRS.includes(topDir)) continue;
    const { date, source } = lastVerifiedDate(relFile);
    if (!date) continue;
    const age = daysSince(date);
    if (age > STALE_DAYS) staleCandidates.push({ relFile, date, source, age });
  }
  staleCandidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  const staleTotal = staleCandidates.length;
  const staleShown = staleCandidates.slice(0, STALE_MAX_LIST);
  const staleExtra = staleTotal - staleShown.length;

  // Check 3: changes since last run
  const prevState = loadState();
  const currentHead = gitCurrentHead();
  let recentChanges = null;
  if (prevState && prevState.lastCommit && currentHead) {
    if (prevState.lastCommit === currentHead) {
      recentChanges = [];
    } else {
      const diffFiles = gitDiffNameOnly(prevState.lastCommit, currentHead);
      if (diffFiles !== null) {
        const scanned = diffFiles.filter((f) => {
          if (!f.endsWith('.md')) return false;
          const topDir = f.split('/')[0];
          if (!SCAN_DIRS.includes(topDir)) return false;
          if (isExcludedForWalk(f)) return false;
          return true;
        });
        recentChanges = scanned.map((relFile) => {
          const chain = ancestorIndexFiles(relFile);
          const rootMemory = path.join(MEMORY_ROOT, 'MEMORY.md');
          const indexFiles = [...chain, rootMemory];
          const indexed = fs.existsSync(path.join(MEMORY_ROOT, relFile))
            ? isReferenced(relFile, indexFiles, indexTextCache)
            : null;
          return { relFile, indexed };
        });
      }
    }
  }

  // ---------- report ----------
  const lines = [];
  lines.push('# Index Gardener Report', '', `Run time: ${nowISO()}`,
    `Files scanned: ${allMdFiles.length} (scope: ${SCAN_DIRS.join(' ')})`, '');

  lines.push(`## Check 1 · Orphan files (${orphans.length})`, '');
  if (orphans.length === 0) lines.push('None.');
  else for (const o of orphans) lines.push(`- \`${o.relFile}\` → suggest indexing in \`${o.suggestedIndex}\``);
  lines.push('');

  lines.push(`## Check 2 · Stale/unverified >${STALE_DAYS} days (${staleTotal} total, showing ${staleShown.length})`, '');
  if (staleTotal === 0) lines.push('None.');
  else {
    for (const s of staleShown) lines.push(`- \`${s.relFile}\` (last verified ${fmtDate(s.date)}, source=${s.source}, ${s.age}d ago)`);
    if (staleExtra > 0) lines.push(`(${staleExtra} more — see full scan)`);
  }
  lines.push('');

  lines.push('## Check 3 · Changes since last run', '');
  if (recentChanges === null) lines.push('First run, no baseline — skipped.');
  else if (recentChanges.length === 0) lines.push('No new changes.');
  else {
    const shown = recentChanges.slice(0, RECENT_MAX_LIST);
    for (const c of shown) {
      const tag = c.indexed === null ? '(deleted/moved)' : c.indexed ? '(indexed)' : '(NOT indexed)';
      lines.push(`- \`${c.relFile}\` ${tag}`);
    }
    if (recentChanges.length > shown.length) lines.push(`(${recentChanges.length - shown.length} more)`);
  }
  lines.push('');

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');

  // ---------- state + dedup ----------
  // Fingerprint on content only (no date component): the module docstring
  // and the log line below both promise "the same finding doesn't spam a
  // log every run" — a true content-only dedup delivers that. Mixing
  // today's date into the hash (the previous behavior) made the fingerprint
  // change every single day regardless of content, so a finding that sat
  // unchanged for a week still logged once a day — the opposite of what
  // "deduped" means here.
  const findingsFingerprint = crypto.createHash('sha1')
    .update(JSON.stringify({ o: orphans.map((x) => x.relFile), s: staleTotal }))
    .digest('hex');
  const prevFingerprint = prevState ? prevState.findingsFingerprint : null;

  saveState({ lastRunISO: nowISO(), lastCommit: currentHead, findingsFingerprint });

  const uncatalogedRecent = recentChanges ? recentChanges.filter((c) => c.indexed === false) : [];
  const hasFindings = orphans.length > 0 || staleTotal > 0 || uncatalogedRecent.length > 0;

  if (hasFindings && findingsFingerprint !== prevFingerprint) {
    const logLines = [`### Index gardener (auto · ${nowHHMM()})`];
    logLines.push(orphans.length > 0 ? `- orphans: ${orphans.length}` : '- orphans: 0');
    logLines.push(`- stale (>${STALE_DAYS}d): ${staleTotal}`);
    const recentCount = recentChanges ? recentChanges.length : 0;
    logLines.push(`- changed since last run: ${recentCount}, unindexed: ${uncatalogedRecent.length}`);
    logLines.push(`(full detail: ${path.relative(MEMORY_ROOT, REPORT_FILE)})`);
    appendLog(logLines.join('\n'));
  }

  console.log(`Files scanned: ${allMdFiles.length}`);
  console.log(`Orphans: ${orphans.length}`);
  console.log(`Stale (>${STALE_DAYS}d): ${staleTotal}`);
  console.log(`Changed since last run: ${recentChanges === null ? 'skipped (first run)' : recentChanges.length}`);
  console.log(`Report: ${REPORT_FILE}`);
}

try {
  main();
} catch (err) {
  console.error('index-gardener crashed:', (err && err.stack) || String(err));
  try { appendLog(`### Index gardener FAILED: ${String((err && err.message) || err).slice(0, 300)}`); } catch { /* best effort */ }
  process.exitCode = 1;
}
