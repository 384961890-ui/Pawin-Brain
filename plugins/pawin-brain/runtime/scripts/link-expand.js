#!/usr/bin/env node
/**
 * link-expand.js — 召回结果的一跳 [[链接]] 展开
 *
 * 职责：inject-context.js 召回的记忆片段（QMD / grep-floor）命中的源文件里
 *      如果引用了 [[slug]]，把这些链接的摘要顺手带出来一句——治"读到 A 没提到
 *      A 里提过的 B，下一句又要重新召回"这种断链。
 *
 * 刹车（硬性，防 context 爆炸，2026-07-22 定）：
 *   - 只展开一跳，邻居的邻居不追
 *   - 每条召回最多展开 3 个链接（优先保留解析成功的前 3 个）
 *   - 单条召回的展开文本 ≤ 600 字符，超了截断
 *   - 解析失败（找不到文件/lesson id、frontmatter 没 description）的 slug 静默跳过
 *
 * 一切 IO 都吞错误，不阻塞主流程（这是 hook，炸了会影响每次对话）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const BRAIN_DIR = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.join(HOME, '.claude-brain')
);
const MEMORY_DIR = process.env.MEMORY_DIR || path.join(BRAIN_DIR, 'memory');
const LESSONS_INDEX_PATH = path.join(BRAIN_DIR, 'lessons/INDEX.json');

const MAX_LINKS_PER_RECALL = 3;
const MAX_EXPAND_CHARS = 600;
const DESC_SNIPPET_CHARS = 120;

// slug（文件名去 .md）→ 绝对路径。启动后建一次缓存在模块作用域，同进程内复用。
let slugMapCache = null;

function walkDir(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) walkDir(full, onFile);
      else if (ent.isFile()) onFile(full);
    } catch { /* 单个条目读失败不影响其余扫描 */ }
  }
}

function buildSlugMap() {
  if (slugMapCache) return slugMapCache;
  const map = new Map();
  try {
    walkDir(MEMORY_DIR, (filePath) => {
      if (!filePath.endsWith('.md')) return;
      const slug = path.basename(filePath, '.md');
      if (!map.has(slug)) map.set(slug, filePath); // 撞名保留先扫到的那个，不报错
    });
  } catch { /* 目录读不到 — 空 map，调用方据此整体跳过展开 */ }
  slugMapCache = map;
  return map;
}

// 供测试重置缓存用（真实 hook 进程一次性，不需要）
function resetSlugMapCache() {
  slugMapCache = null;
}

let lessonsCache = null;
function lookupLessonSummary(id) {
  if (lessonsCache === null) {
    try {
      const idx = JSON.parse(fs.readFileSync(LESSONS_INDEX_PATH, 'utf-8'));
      lessonsCache = new Map((idx.lessons || []).map(l => [l.id, l.summary || l.title || '']));
    } catch { lessonsCache = new Map(); }
  }
  return lessonsCache.get(id) || null;
}

// frontmatter 里抽 description 一行（不引入 yaml 依赖，正则够用）
function readDescription(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    return desc ? desc[1].trim() : null;
  } catch { return null; }
}

// 文件正文里去重后的 [[slug]] 列表
function extractLinks(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const matches = raw.match(/\[\[([^[\]]+)\]\]/g) || [];
    const slugs = matches.map(m => m.slice(2, -2).trim()).filter(Boolean);
    return [...new Set(slugs)];
  } catch { return []; }
}

// 单个 slug → 一行展开摘要；解析不出返回 null
function resolveSlug(slug, slugMap) {
  try {
    if (slug.startsWith('L-')) {
      const summary = lookupLessonSummary(slug);
      return summary ? `· [[${slug}]] — ${summary.slice(0, DESC_SNIPPET_CHARS)}` : null;
    }
    const targetPath = slugMap.get(slug);
    if (!targetPath) return null;
    const desc = readDescription(targetPath);
    return desc ? `· [[${slug}]] — ${desc.slice(0, DESC_SNIPPET_CHARS)}` : null;
  } catch { return null; }
}

// 单条召回 → 展开块文本；拿不到源文件路径或展开不出内容 → 空串
function buildExpansionBlock(recallItem, slugMap) {
  try {
    const fileField = recallItem && (recallItem.file || recallItem.source);
    // grepFloor 条目 file === 'grep-floor'，不是真路径，跳过；qmdSearch 条目 file 是源文件 basename
    if (!fileField || fileField === 'grep-floor') return '';
    const sourcePath = slugMap.get(path.basename(fileField, '.md'));
    if (!sourcePath) return '';

    const links = extractLinks(sourcePath);
    if (links.length === 0) return '';

    const lines = [];
    for (const slug of links) {
      if (lines.length >= MAX_LINKS_PER_RECALL) break; // 只保留能解析成功的前 3 个
      const line = resolveSlug(slug, slugMap);
      if (line) lines.push(line);
    }
    if (lines.length === 0) return '';

    let body = lines.join('\n');
    if (body.length > MAX_EXPAND_CHARS) body = body.slice(0, MAX_EXPAND_CHARS) + '…';
    return `↳ 关联记忆：\n${body}`;
  } catch { return ''; }
}

/**
 * expandLinks(recall, config) — 给每条召回结果附加一跳链接展开
 * 不改召回内容/顺序（不碰 grep/qmd/intent 路由），只在每条上新增一个 linkBlock 字段。
 * 返回新数组（不 mutate 传入的 recall 及其元素，符合 immutable 风格）。
 */
function expandLinks(recall, config) {
  try {
    if (!config || config.link_expansion_enabled === false) return recall;
    if (!Array.isArray(recall) || recall.length === 0) return recall;
    const slugMap = buildSlugMap();
    if (slugMap.size === 0) return recall;
    const out = recall.map((r) => {
      try {
        const block = buildExpansionBlock(r, slugMap);
        return block ? { ...r, linkBlock: block } : r;
      } catch { return r; }
    });
    // A6 修复（2026-07-22）：.map() 产出的是普通新数组，不带 recall 的 .failed 标记 ——
    // util.js qmdSearch 靠这个标记区分"真没有"和"没查成"（7/20 铁律），漏了它相当于
    // 把 7/20 修的静默失败又静默改了回去。这里显式搬过去。
    if (recall.failed) out.failed = recall.failed;
    return out;
  } catch { return recall; }
}

module.exports = {
  expandLinks, buildSlugMap, resetSlugMapCache,
  MAX_LINKS_PER_RECALL, MAX_EXPAND_CHARS
};
