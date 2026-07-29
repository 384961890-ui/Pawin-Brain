#!/usr/bin/env node
/**
 * generate-index.js — refresh the machine-owned AUTO blocks in an index file.
 *
 * Purpose: hand-written status snapshots rot (see LESSONS-LEARNED.md #1) —
 * whatever an INDEX.md's status section says is only as fresh as the last
 * time someone remembered to update it by hand. This script replaces that
 * habit with a scoped regex substitution: content between
 * `<!-- AUTO:NAME BEGIN -->` and `<!-- AUTO:NAME END -->` markers is fully
 * owned by this script and regenerated from live sources of truth on every
 * run. Everything outside those markers is left untouched.
 *
 * Design constraints (see SPEC.md §5.1):
 *   - Idempotent: running twice in a row produces identical output.
 *   - Fails silently, never blocks: if a source of truth can't be read,
 *     leave that block unchanged and exit 0 — this is meant to be safe to
 *     call from an end-of-turn hook where a crash would be worse than a
 *     stale block.
 *   - Scoped: only touches text between its own named markers.
 *
 * Configuration is entirely through environment variables — there is no
 * project-specific logic baked in here. Wire your own "block sources" by
 * editing the BLOCK_SOURCES section below to point at whatever files or
 * endpoints are authoritative for your project (a health-check endpoint,
 * a JSON state file, a directory listing, etc).
 *
 * Env vars:
 *   MEMORY_DIR       — root of the memory tree (default: ~/memory)
 *   INDEX_FILE        — path to the index file to refresh, relative to
 *                        MEMORY_DIR (default: INDEX.md)
 *
 * Usage: node generate-index.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MEMORY_DIR = process.env.MEMORY_DIR || path.join(os.homedir(), 'memory');
const INDEX_FILE = path.join(MEMORY_DIR, process.env.INDEX_FILE || 'INDEX.md');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * BLOCK_SOURCES — map of AUTO block name → function producing its
 * replacement content (as a string). Each function must be defensive:
 * catch its own errors and return null to mean "leave this block alone."
 *
 * These two are illustrative examples of the kinds of sources a real
 * project wires up — a state file and a directory count. A health-endpoint
 * source is mentioned in SPEC.md §5.1 as a third possibility but isn't
 * wired up here since it would require an actual endpoint to call; add one
 * following the same pattern (return a string, or null to leave the block
 * untouched) if your project has one. Replace/extend these for your own
 * project; nothing here is required.
 */
const BLOCK_SOURCES = {
  // Example: summarize a JSON state file living under MEMORY_DIR/state/.
  STATE: () => {
    const statePath = path.join(MEMORY_DIR, 'state', 'status.json');
    const state = readJson(statePath);
    if (!state) return null;
    const today = new Date().toISOString().slice(0, 10);
    const lines = Object.entries(state).map(([k, v]) => `- ${k}: ${v}`);
    return lines.join('\n') + `\n\n_(auto-generated ${today} from state/status.json)_`;
  },

  // Example: count leaf files in each top-level category directory.
  COUNTS: () => {
    try {
      const entries = fs.readdirSync(MEMORY_DIR, { withFileTypes: true });
      // Skip both _archive-style (excluded-from-scans) and dot-prefixed
      // (tooling state, e.g. .gardener-state/) directories — neither is a
      // memory category and counting them just adds noise to the block.
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'));
      const lines = dirs.map((d) => {
        const files = fs.readdirSync(path.join(MEMORY_DIR, d.name))
          .filter((f) => f.endsWith('.md') && f !== 'INDEX.md');
        return `- ${d.name}/: ${files.length} entries`;
      });
      return lines.join('\n');
    } catch {
      return null;
    }
  },
};

function refreshBlocks(text) {
  let out = text;
  for (const [name, produce] of Object.entries(BLOCK_SOURCES)) {
    let content;
    try { content = produce(); } catch { content = null; }
    if (content === null) continue; // source unavailable — leave block as-is
    // 'g' flag: an index file may legitimately contain the same AUTO block
    // name more than once (e.g. repeated in a "see also" section) — without
    // it, only the first occurrence would ever refresh and the rest would
    // silently go stale forever.
    const re = new RegExp(
      `(<!-- AUTO:${name} BEGIN -->)[\\s\\S]*?(<!-- AUTO:${name} END -->)`, 'g'
    );
    if (re.test(out)) out = out.replace(re, `$1\n${content}\n$2`);
  }
  return out;
}

function main() {
  let text;
  try {
    text = fs.readFileSync(INDEX_FILE, 'utf-8');
  } catch {
    process.exit(0); // no index file to refresh — nothing to do
  }

  const refreshed = refreshBlocks(text);
  if (refreshed === text) process.exit(0); // no-op, avoid a spurious mtime bump

  try {
    // pid-suffixed tmp name: a fixed '.tmp' name would let two concurrent
    // runs (e.g. two overlapping hook invocations) clobber each other's
    // staging file before either rename lands — the same atomic-write
    // convention util.js uses elsewhere in this package.
    const tmp = `${INDEX_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, refreshed);
    fs.renameSync(tmp, INDEX_FILE); // atomic swap — never leaves a half-written index
  } catch {
    // Silent by design: a refresh failure should never block whatever
    // process (e.g. an end-of-turn hook) called this script.
  }
}

main();
