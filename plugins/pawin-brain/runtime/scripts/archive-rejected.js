#!/usr/bin/env node
/**
 * archive-rejected.js — claude-brain v8 卫生 · rejected 条目归档
 *
 * INDEX.json 里 152/164 条是 status=rejected 的历史噪音，天天跟着活条目一起
 * 被 loadLessons 过滤、被 decay-lessons 扫描——占地方不产生价值。
 * 搬去 lessons/ARCHIVE.json 冷藏，INDEX.json 只留非 rejected 条目。
 *
 * ⚠️ 红线 3：本脚本改 INDEX.json 结构，施工队只准跑 --dry-run 和 --self-check，
 *          真实执行（--apply）由验收人做。
 *
 * Usage:
 *   node archive-rejected.js            # 默认 dry-run，只打印会搬多少条
 *   node archive-rejected.js --dry-run  # 同上，显式写法
 *   node archive-rejected.js --apply    # 真搬（先备份 INDEX.json 再写）
 *   node archive-rejected.js --self-check
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { BRAIN_DIR, readFileSafe, writeFileAtomic, nowISO } = require('./util.js');

const INDEX_PATH = path.join(BRAIN_DIR, 'lessons/INDEX.json');
const ARCHIVE_PATH = path.join(BRAIN_DIR, 'lessons/ARCHIVE.json');

if (require.main === module) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    process.exit(0);
  }
  const apply = process.argv.includes('--apply');
  const r = archiveRejected(INDEX_PATH, ARCHIVE_PATH, { dryRun: !apply });
  console.log(formatReport(r, !apply));
  process.exit(0);
}

/**
 * @param {string} indexPath
 * @param {string} archivePath
 * @param {{ dryRun?: boolean }} [opts] dryRun 默认 true，显式传 false 才真写文件
 * @returns {{ moved: number, kept: number, backupPath: string|null }}
 */
function archiveRejected(indexPath, archivePath, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}'));
  if (!Array.isArray(idx.lessons)) idx.lessons = [];

  const rejected = idx.lessons.filter(l => l.status === 'rejected');
  const kept = idx.lessons.filter(l => l.status !== 'rejected');

  let backupPath = null;
  if (!dryRun && rejected.length > 0) {
    // 先备份原 INDEX（含未搬前的全量），再动手写变更
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    backupPath = `${indexPath}.bak-pre-v8-${yyyymmdd}`;
    fs.copyFileSync(indexPath, backupPath);

    // 追加进 ARCHIVE.json（已存在则合并进其 lessons 数组）
    let archive;
    try { archive = JSON.parse(readFileSafe(archivePath, '')); }
    catch { archive = null; }
    if (!archive || !Array.isArray(archive.lessons)) {
      archive = { version: 1, archived_at: nowISO(), lessons: [] };
    }
    archive.lessons = archive.lessons.concat(rejected);
    archive.archived_at = nowISO();
    writeFileAtomic(archivePath, JSON.stringify(archive, null, 2));

    idx.lessons = kept;
    writeFileAtomic(indexPath, JSON.stringify(idx, null, 2));
  }

  return { moved: rejected.length, kept: kept.length, backupPath };
}

function formatReport(r, dryRun) {
  const tag = dryRun ? 'DRY-RUN' : 'APPLIED';
  const lines = [
    `[${tag}] archive-rejected`,
    `  将搬 ${r.moved} 条 rejected → ARCHIVE.json，留 ${r.kept} 条在 INDEX.json`
  ];
  if (r.backupPath) lines.push(`  备份: ${r.backupPath}`);
  if (dryRun) lines.push('  （dry-run，未写文件；--apply 才真跑）');
  return lines.join('\n');
}

module.exports = { archiveRejected, formatReport };

/**
 * 自检：跑 `node archive-rejected.js --self-check`
 * 全程用 os.tmpdir() 造假 INDEX，不碰真 INDEX.json / 真 ARCHIVE.json
 */
function runSelfCheck() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rejected-selfcheck-'));
  const indexPath = path.join(tmpRoot, 'INDEX.json');
  const archivePath = path.join(tmpRoot, 'ARCHIVE.json');

  let pass = 0;
  const fixture = {
    lessons: [
      { id: 'L-1', status: 'confirmed', title: 'keep1' },
      { id: 'L-2', status: 'rejected', title: 'trash1' },
      { id: 'L-3', status: 'draft', title: 'keep2' },
      { id: 'L-4', status: 'rejected', title: 'trash2' },
      { id: 'L-5', status: 'rejected', title: 'trash3' }
    ]
  };
  fs.writeFileSync(indexPath, JSON.stringify(fixture));

  // dry-run：只报数字，不该写任何文件
  const r1 = archiveRejected(indexPath, archivePath, { dryRun: true });
  if (r1.moved !== 3) throw new Error(`dry-run moved expect 3 got ${r1.moved}`);
  if (r1.kept !== 2) throw new Error(`dry-run kept expect 2 got ${r1.kept}`);
  if (fs.existsSync(archivePath)) throw new Error('dry-run should not create ARCHIVE.json');
  const afterDry = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  if (afterDry.lessons.length !== 5) throw new Error('dry-run should not mutate INDEX.json');
  console.log(`PASS | dry-run: moved=3 kept=2, no files written`);
  pass++;

  // 真跑：验证搬运数字 + 备份存在 + ARCHIVE.json 内容
  const r2 = archiveRejected(indexPath, archivePath, { dryRun: false });
  if (r2.moved !== 3) throw new Error(`apply moved expect 3 got ${r2.moved}`);
  if (r2.kept !== 2) throw new Error(`apply kept expect 2 got ${r2.kept}`);
  if (!r2.backupPath || !fs.existsSync(r2.backupPath)) throw new Error('backup file missing');
  const backupContent = JSON.parse(fs.readFileSync(r2.backupPath, 'utf-8'));
  if (backupContent.lessons.length !== 5) throw new Error('backup should contain original 5 lessons');
  const afterApply = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  if (afterApply.lessons.length !== 2) throw new Error('INDEX should keep 2 lessons after apply');
  if (afterApply.lessons.some(l => l.status === 'rejected')) throw new Error('no rejected should remain in INDEX');
  const archiveContent = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
  if (archiveContent.lessons.length !== 3) throw new Error('ARCHIVE.json should contain 3 rejected lessons');
  console.log(`PASS | apply: moved=3 kept=2, backup=${path.basename(r2.backupPath)}, ARCHIVE.json has 3`);
  pass++;

  // 追加场景：再跑一次归档，验证合并进已存在的 ARCHIVE.json 而不是覆盖
  fs.writeFileSync(indexPath, JSON.stringify({
    lessons: [
      { id: 'L-6', status: 'confirmed', title: 'keep3' },
      { id: 'L-7', status: 'rejected', title: 'trash4' }
    ]
  }));
  archiveRejected(indexPath, archivePath, { dryRun: false });
  const archiveAfter2 = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
  if (archiveAfter2.lessons.length !== 4) throw new Error(`ARCHIVE.json should accumulate to 4, got ${archiveAfter2.lessons.length}`);
  console.log(`PASS | append to existing ARCHIVE.json: now has ${archiveAfter2.lessons.length} lessons`);
  pass++;

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  console.log(`\nself-check: ${pass} pass`);
}
