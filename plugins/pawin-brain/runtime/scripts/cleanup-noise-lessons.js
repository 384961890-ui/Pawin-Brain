#!/usr/bin/env node
/**
 * cleanup-noise-lessons.js — 一次性清理 6/22 后用旧逻辑 capture 的噪音 lesson
 *
 * 旧 capture-lesson 用"末尾 3 条拼起来打分"+ score>=1 阈值 → 大量误射
 * 新阈值 = 只看 last_msg + score>=2 (v7.1)
 * 用新标准重放 lesson.summary（≈ last_msg），<2 分的 → reject + lifecycle=archive
 *
 * Usage:
 *   node cleanup-noise-lessons.js            # dry-run，列出会被清的
 *   node cleanup-noise-lessons.js --apply    # 真改
 */

const fs = require('fs');
const path = require('path');
const { BRAIN_DIR, readFileSafe, writeFileAtomic } = require('./util.js');

const CORRECTION_PATTERNS = [
  /算了[，,。!！\s]|^算了\s*$/m,
  /随便(?:吧|你)/,
  /(?:不要|别)再(?:这样|犯|说|搞)/,
  /我不(?:管|想说|想问)了/,
  /不是这样|又犯|又这样|搞错了|纠正你|纠正我|你错了|不对/,
  /(?:why|how come)(?:.{0,10})(?:always|again|keep)/i,
  /(?:降级|降智|又掉|掉进)/,
  /(?:我|你)之前(?:说|告诉|提过|讲过)过?/,
  /你(?:应该|不应该)/,
  /我(?:发现|觉得|跟你说)你(?:每次|总是|又|这样)/,
];
const POSITIVE_PATTERNS = [
  /你做得(?:很)?好|完美|你说得对|这次(?:对了|做对了)|做得不错/,
  /(?:这版|这次|这个).+(?:比.+好|更好|不错)/,
  /^(?:好的|没错|对的|完美|搞定|可以|行)[，,。!！?？\s]*$/m,
];

function score(text) {
  let s = 0;
  for (const p of CORRECTION_PATTERNS) if (p.test(text)) s++;
  let neg = 0;
  for (const p of POSITIVE_PATTERNS) if (p.test(text)) neg++;
  return Math.max(0, s - neg);
}

const apply = process.argv.includes('--apply');
const cutoff = process.argv.find(a => a.startsWith('--since='))?.slice(8) || '2026-06-22';

const indexPath = path.join(BRAIN_DIR, 'lessons/INDEX.json');
const idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}'));

let kept = 0, rejected = 0;
const rejectedList = [];

for (const l of idx.lessons) {
  if ((l.created || '') < cutoff) continue;
  if (l.status !== 'draft') continue; // 不动 confirmed/rejected
  const s = score(l.summary || l.title || '');
  if (s < 2) {
    rejected++;
    rejectedList.push({ id: l.id, score: s, title: (l.title || '').slice(0, 50) });
    if (apply) {
      l.status = 'rejected';
      l.lifecycle = 'archive';
      l.rejected_reason = 'v7.1 cleanup: signal_score<2 with new last-msg-only rule';
      l.rejected_at = new Date().toISOString();
    }
  } else {
    kept++;
  }
}

console.log(`扫描 since=${cutoff}`);
console.log(`保留 (score>=2): ${kept}`);
console.log(`${apply ? '已 reject' : '将 reject'} (score<2): ${rejected}`);
console.log('---被 reject 的样本---');
rejectedList.slice(0, 15).forEach(r => {
  console.log(`  score=${r.score} | ${r.id} | ${r.title}`);
});
if (rejectedList.length > 15) console.log(`  ... 还有 ${rejectedList.length - 15} 条`);

if (apply) {
  writeFileAtomic(indexPath, JSON.stringify(idx, null, 2));
  console.log('\n✅ INDEX.json 已更新');
} else {
  console.log('\n💡 dry-run。加 --apply 真改');
}
