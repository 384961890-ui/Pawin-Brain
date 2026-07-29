#!/usr/bin/env node
/**
 * memory-write-guard.js — write-time format gate for governed memory files.
 *
 * Purpose: catching a malformed memory write at write time is far cheaper
 * than catching it at the next scheduled audit — the cost of the former is
 * "redo this one write," the cost of the latter is "figure out which of
 * today's writes broke the rule, hope nothing downstream already read the
 * bad version" (see LESSONS-LEARNED.md #4). This script is meant to be
 * wired as a PostToolUse (or equivalent pre-commit) hook on any tool that
 * writes/edits files, and rejects writes to governed memory files that
 * don't satisfy the dual-section format from SPEC.md §2–3.
 *
 * Checks enforced:
 *   - a frontmatter block anchored at the true start of the file
 *     (--- ... ---), CRLF/BOM tolerant. This is a presence/shape check, not
 *     a full YAML parse — malformed YAML with the right field names in
 *     place (e.g. an unclosed list) will still pass. A prose "---" divider
 *     that isn't at the top of the file is never mistaken for this block.
 *   - frontmatter has name / description / metadata.type (regex presence
 *     check on field names, not schema validation)
 *   - last-verified, if present anywhere in the frontmatter block (top
 *     level or indented under `metadata:`, per SPEC.md §2.1), is YYYY-MM-DD
 *   - a `## History` (or house-style equivalent, see HISTORY_HEADING_RE)
 *     section exists and is not inside a fenced code block
 *   - that section has at least one dated entry ("- YYYY-MM-DD · ...")
 *
 * Scope: only files under $MEMORY_GUARD_ROOT, only under the configured
 * governed top-level directories, excluding MEMORY.md/INDEX.md (navigation
 * files, not memory records) and anything under an _archive/ segment
 * (frozen, not subject to ongoing format rules).
 *
 * Fails open by design on anything outside its narrow contract — internal
 * errors, unreadable files, paths outside the governed root all exit 0.
 * A bug in the gate itself must never block unrelated work.
 *
 * Input: JSON on stdin with a `tool_input.file_path` string field — the
 * common shape emitted by Claude Code-style PostToolUse hooks. Adapt the
 * stdin parsing in `readFilePathFromStdin()` if your harness's hook
 * payload has a different shape.
 *
 * Exit codes: 2 = violation (details on stderr), 0 = pass or out of scope.
 *
 * Env vars:
 *   MEMORY_GUARD_ROOT   — root of the memory tree the guard enforces.
 *                           Falls back to MEMORY_DIR (the same variable the
 *                           other three scripts read) if unset, then to
 *                           ~/memory if neither is set. Only set
 *                           MEMORY_GUARD_ROOT explicitly if this hook needs
 *                           a root different from the rest of the pipeline —
 *                           otherwise setting MEMORY_DIR alone is enough to
 *                           keep every script (including this one) pointed
 *                           at the same tree.
 *   MEMORY_GUARD_DIRS    — comma-separated governed top-level dirs
 *                           (default: feedback,projects,partners,reference,user,lessons)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMORY_ROOT = process.env.MEMORY_GUARD_ROOT || process.env.MEMORY_DIR || path.join(os.homedir(), 'memory');
// Only directories with dual-section discipline are governed — scratch/log/
// vault/identity/archive areas are free-form by design and out of scope.
const ENFORCED_DIRS = (process.env.MEMORY_GUARD_DIRS ||
  'feedback,projects,partners,reference,user,lessons').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_BASENAMES = new Set(['MEMORY.md', 'INDEX.md']);
// House style may call this section "## History", "## Log", etc. Adjust to taste.
const HISTORY_HEADING_RE = /^##\s*History\s*$/m;

function readFilePathFromStdin() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { return null; }
  try { return JSON.parse(input).tool_input?.file_path; } catch { return null; }
}

function main() {
  let fp = readFilePathFromStdin();
  if (typeof fp !== 'string' || !fp.endsWith('.md')) return 0;
  if (fp.startsWith('~/')) fp = path.join(os.homedir(), fp.slice(2));

  let abs = path.resolve(fp);
  try { abs = fs.realpathSync(abs); } catch { /* file may not exist yet on this call path — proceed with resolved path */ }
  let rootBase = path.resolve(MEMORY_ROOT);
  try { rootBase = fs.realpathSync(rootBase); } catch { /* root itself may not exist yet */ }
  const root = rootBase + path.sep;
  // Case-insensitive prefix compare: guards against case-variant path aliasing
  // on case-insensitive filesystems (e.g. default macOS APFS).
  if (!abs.toLowerCase().startsWith(root.toLowerCase())) return 0;

  const rel = abs.slice(root.length);
  const topDir = rel.split(path.sep)[0].toLowerCase();
  if (!ENFORCED_DIRS.map((d) => d.toLowerCase()).includes(topDir)) return 0;
  if (SKIP_BASENAMES.has(path.basename(abs))) return 0;
  if (rel.split(path.sep).some((seg) => seg === '_archive')) return 0;

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return 0; }
  text = text.replace(/^﻿/, ''); // tolerate a leading BOM

  const errs = [];

  // Frontmatter block: CRLF-tolerant; anchored to the true start of the file
  // (no 'm' flag on the opening `^`) so a "---"-delimited horizontal rule
  // sitting in the prose body can never be mistaken for the header — only
  // a --- that opens the file at position 0 counts. The closing --- must
  // be immediately followed by a newline or end-of-string, i.e. on its own
  // line, so it can't grab a later prose divider either.
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fmMatch) {
    errs.push('missing frontmatter block (file must open with a --- delimited YAML header)');
  } else {
    const fm = fmMatch[1];
    if (!/^name:\s*\S+/m.test(fm)) errs.push('frontmatter missing `name` field');
    if (!/^description:\s*\S+/m.test(fm)) errs.push('frontmatter missing `description` field');
    if (!/^\s+type:\s*\S+/m.test(fm) && !/^type:\s*\S+/m.test(fm)) errs.push('frontmatter missing `metadata.type` field');
    // last-verified may sit at the top level or, per SPEC.md §2.1's
    // canonical shape, indented under `metadata:` — match either position.
    const lv = fm.match(/^\s*last-verified:\s*"?([^"\r\n]+?)"?\s*$/m);
    if (lv && !/^\d{4}-\d{2}-\d{2}$/.test(lv[1])) errs.push(`last-verified has wrong format (want YYYY-MM-DD, got ${lv[1]})`);
  }

  // Dual-section rule: a History section (outside fenced code blocks, to
  // prevent a code sample from being mistaken for a real history entry)
  // with at least one dated line.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const historyMatch = prose.match(HISTORY_HEADING_RE);
  if (!historyMatch) {
    errs.push('missing a History section (dual-section format: current conclusion + append-only history)');
  } else if (!/^-\s*\d{4}-\d{2}-\d{2}/m.test(prose.slice(historyMatch.index))) {
    errs.push('History section has no dated entry ("- YYYY-MM-DD · ..." format)');
  }

  if (errs.length) {
    process.stderr.write(
      `Memory write guard rejected ${rel}\n` +
      errs.map((e) => `  - ${e}`).join('\n') +
      '\nFix: add the missing fields/section and rewrite. History entry format: - YYYY-MM-DD · what changed · why\n'
    );
    return 2;
  }
  return 0;
}

try { process.exit(main()); } catch { process.exit(0); } // gate's own failure must never block a normal write
