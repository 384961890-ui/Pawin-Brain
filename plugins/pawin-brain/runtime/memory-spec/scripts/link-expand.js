/**
 * link-expand.js — one-hop [[wikilink]] expansion for retrieval results.
 *
 * Purpose: when a retrieval pass (grep/embedding search/whatever) returns a
 * memory file, that file's body may reference other memory files via
 * `[[slug]]`. Without expansion, an agent reading the retrieved file has no
 * idea those linked facts exist unless it happens to issue a second query —
 * "read A, A mentions something about B, now go query for B" is a wasted
 * round trip that this module collapses into the first retrieval pass.
 *
 * Hard limits (see SPEC.md §6) — all non-negotiable, because this runs on
 * every retrieval call and must have bounded cost:
 *   - expand exactly one hop; never recurse into a neighbor's own links
 *   - cap links expanded per source file (MAX_LINKS_PER_RECALL)
 *   - cap total expanded text per source file (MAX_EXPAND_CHARS)
 *   - unresolvable slugs are skipped silently, not treated as errors
 *
 * All I/O swallows its own errors — this is meant to be safe to call from a
 * hook that runs on every turn; a bug here should degrade retrieval quality,
 * never crash the caller.
 *
 * Env vars:
 *   MEMORY_DIR         — root of the memory tree (default: ~/memory)
 *   LESSONS_INDEX_PATH  — optional path to a JSON index of `lesson`-type
 *                          records keyed by an ID scheme (e.g. "L-001")
 *                          instead of a filename slug. Only needed if your
 *                          project uses ID-based lessons rather than
 *                          file-based slugs for that one type.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const MEMORY_DIR = process.env.MEMORY_DIR || path.join(HOME, 'memory');
const LESSONS_INDEX_PATH = process.env.LESSONS_INDEX_PATH || null;

const MAX_LINKS_PER_RECALL = 3;
const MAX_EXPAND_CHARS = 600;
const DESC_SNIPPET_CHARS = 120;

// slug (filename minus .md) → absolute path. Built once per process, reused.
let slugMapCache = null;

function walkDir(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) walkDir(full, onFile);
      else if (ent.isFile()) onFile(full);
    } catch { /* one bad entry shouldn't stop the rest of the scan */ }
  }
}

function buildSlugMap() {
  if (slugMapCache) return slugMapCache;
  const map = new Map();
  try {
    walkDir(MEMORY_DIR, (filePath) => {
      if (!filePath.endsWith('.md')) return;
      const slug = path.basename(filePath, '.md');
      if (!map.has(slug)) map.set(slug, filePath); // first match wins on collision, no error
    });
  } catch { /* directory unreadable — empty map, caller skips expansion entirely */ }
  slugMapCache = map;
  return map;
}

// Exposed for tests — real hook processes are one-shot and don't need this.
function resetSlugMapCache() {
  slugMapCache = null;
}

let lessonsCache = null;
function lookupLessonSummary(id) {
  if (!LESSONS_INDEX_PATH) return null;
  if (lessonsCache === null) {
    try {
      const idx = JSON.parse(fs.readFileSync(LESSONS_INDEX_PATH, 'utf-8'));
      lessonsCache = new Map((idx.lessons || []).map((l) => [l.id, l.summary || l.title || '']));
    } catch {
      lessonsCache = new Map();
    }
  }
  return lessonsCache.get(id) || null;
}

// Pull the `description` line out of a file's frontmatter (no yaml dep needed).
function readDescription(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    return desc ? desc[1].trim() : null;
  } catch {
    return null;
  }
}

// Deduped [[slug]] references found in a file's body.
function extractLinks(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const matches = raw.match(/\[\[([^[\]]+)\]\]/g) || [];
    const slugs = matches.map((m) => m.slice(2, -2).trim()).filter(Boolean);
    return [...new Set(slugs)];
  } catch {
    return [];
  }
}

// Single slug → one-line expansion string, or null if unresolvable.
function resolveSlug(slug, slugMap) {
  try {
    if (LESSONS_INDEX_PATH && /^L-/.test(slug)) {
      const summary = lookupLessonSummary(slug);
      return summary ? `· [[${slug}]] — ${summary.slice(0, DESC_SNIPPET_CHARS)}` : null;
    }
    const targetPath = slugMap.get(slug);
    if (!targetPath) return null;
    const desc = readDescription(targetPath);
    return desc ? `· [[${slug}]] — ${desc.slice(0, DESC_SNIPPET_CHARS)}` : null;
  } catch {
    return null;
  }
}

// Single retrieved item → expansion block text; '' if nothing to add.
function buildExpansionBlock(recallItem, slugMap) {
  try {
    const fileField = recallItem && (recallItem.file || recallItem.source);
    if (!fileField) return '';
    const sourcePath = slugMap.get(path.basename(fileField, '.md'));
    if (!sourcePath) return '';

    const links = extractLinks(sourcePath);
    if (links.length === 0) return '';

    const lines = [];
    for (const slug of links) {
      if (lines.length >= MAX_LINKS_PER_RECALL) break;
      const line = resolveSlug(slug, slugMap);
      if (line) lines.push(line);
    }
    if (lines.length === 0) return '';

    let body = lines.join('\n');
    if (body.length > MAX_EXPAND_CHARS) body = body.slice(0, MAX_EXPAND_CHARS) + '…';
    return `↳ related memories:\n${body}`;
  } catch {
    return '';
  }
}

/**
 * expandLinks(recall, config) — append a one-hop wikilink expansion to each
 * retrieved item. Does not alter recall content/order in any other way
 * (retrieval ranking/routing is out of scope here) — only adds a
 * `linkBlock` field per item. Returns a new array; never mutates the input
 * array or its elements (immutable by convention).
 *
 * `recall` — array of items, each expected to have a `.file` or `.source`
 * field naming the memory file it came from.
 * `config.link_expansion_enabled` — set to false to disable expansion
 * entirely (default: enabled).
 */
function expandLinks(recall, config) {
  try {
    if (config && config.link_expansion_enabled === false) return recall;
    if (!Array.isArray(recall) || recall.length === 0) return recall;
    const slugMap = buildSlugMap();
    if (slugMap.size === 0) return recall;
    return recall.map((r) => {
      try {
        const block = buildExpansionBlock(r, slugMap);
        return block ? { ...r, linkBlock: block } : r;
      } catch {
        return r;
      }
    });
  } catch {
    return recall;
  }
}

module.exports = {
  expandLinks,
  buildSlugMap,
  resetSlugMapCache,
  MAX_LINKS_PER_RECALL,
  MAX_EXPAND_CHARS,
};
