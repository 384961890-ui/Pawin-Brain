#!/usr/bin/env node
/**
 * decay-lessons.js — claude-brain v7 P2 记忆活跃度降权
 *
 * 规则：
 *   - active + last_activated 超过 3 个月 → cooling（不再被 inject-context 注入）
 *   - cooling + last_activated 超过 6 个月 → archive（深度归档）
 *   - archive 是终态，不自动恢复（手工 promote 才能拉回 active）
 *
 * 用法：
 *   node decay-lessons.js           # 跑一次正式 decay
 *   node decay-lessons.js --dry-run # 不写文件，只打印会改什么
 *   node decay-lessons.js --self-check
 *
 * 不调 LLM。用户自己挂 cron 或手跑。
 */

const fs = require('fs');
const path = require('path');
const {
  BRAIN_DIR, writeFileAtomic, readFileSafe, nowISO
} = require('./util.js');

const INDEX_PATH = path.join(BRAIN_DIR, 'lessons/INDEX.json');

// ponytail: 阈值是初版估值，跑一两个月后看分布再调
const COOLING_AFTER_MS = 90 * 24 * 3600 * 1000;   // 3 个月（普通 lesson）
const ARCHIVE_AFTER_MS = 180 * 24 * 3600 * 1000;  // 6 个月（普通 lesson）
// IDENTITY 类（high severity + confirmed）走 ×2 阈值：身份级常识就算 3 月没碰也不该降级
// 例："凌晨规则 明天=当天白天" 这种 lesson 没碰场景 = 用户没再犯 = 它起作用了，不该被惩罚
const IDENTITY_MULTIPLIER = 2;

if (require.main === module) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run');
  const result = decay(INDEX_PATH, { dryRun });
  console.log(formatReport(result, dryRun));
  process.exit(0);
}

/**
 * @param {string} indexPath
 * @param {{ dryRun?: boolean, now?: number }} opts
 * @returns {{ total, scanned, to_cooling, to_archive, untouched, changes }}
 */
function decay(indexPath, opts = {}) {
  const dryRun = !!opts.dryRun;
  const now = opts.now || Date.now();
  const idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}'));
  if (!Array.isArray(idx.lessons)) idx.lessons = [];

  const changes = [];
  let toCooling = 0, toArchive = 0;
  for (const l of idx.lessons) {
    const lifecycle = l.lifecycle || 'active';
    const last = Date.parse(l.last_activated || l.created || '') || 0;
    if (last === 0) continue; // sanity guard：last_activated 解析失败的 lesson 不动（避免错误立即 archive）
    const ageMs = now - last;
    let next = lifecycle;
    let reason = 'time';

    // IDENTITY 类身份级常识走更宽松阈值
    const isIdentity = l.severity === 'high' && l.status === 'confirmed';

    // v8 疗效通道：数据说这条教训没用/有用，比时间快（时间判断之前跑）
    // ponytail: 0.5/0.8 是初版估值，跑一个月看 analyze-behavior 分布再调
    const eff = l.efficacy;
    let effLow = false, effHigh = false, effAvg;
    if (eff && eff.sessions >= 5) {
      effAvg = eff.score_sum / eff.sessions;
      if (effAvg < 0.5) effLow = true;
      else if (effAvg >= 0.8) effHigh = true;
    }

    // 疗效好的教训享受 identity 同款保护（时间阈值 ×2），合并成一个 isProtected，不写两套阈值
    const isProtected = isIdentity || effHigh;
    const coolThr = isProtected ? COOLING_AFTER_MS * IDENTITY_MULTIPLIER : COOLING_AFTER_MS;
    const archThr = isProtected ? ARCHIVE_AFTER_MS * IDENTITY_MULTIPLIER : ARCHIVE_AFTER_MS;

    if (effLow && !isIdentity && lifecycle === 'active') {
      // 激活了 5+ 次行为分照样烂 = 提醒无效，比时间通道快，不等 90 天
      // v8 验收修：identity 级豁免——行为分是 session 整体分不是这条教训的因果贡献，
      // 身份级常识常在烂 session 被激活（本就是去救火的），不该被混杂噪声打入冷宫
      next = 'cooling';
      reason = 'efficacy_low';
      toCooling++;
    } else if (lifecycle === 'active' && ageMs > coolThr) {
      next = 'cooling';
      toCooling++;
    } else if (lifecycle === 'cooling' && ageMs > archThr) {
      next = 'archive';
      toArchive++;
    }
    if (next !== lifecycle) {
      changes.push({
        id: l.id, title: l.title, from: lifecycle, to: next,
        age_days: Math.floor(ageMs / 86400000),
        identity: isIdentity || undefined,
        reason,
        efficacy_avg: effAvg !== undefined ? +effAvg.toFixed(2) : undefined
      });
      if (!dryRun) l.lifecycle = next;
    }
  }

  if (!dryRun && changes.length > 0) {
    writeFileAtomic(indexPath, JSON.stringify(idx, null, 2));
  }

  return {
    total: idx.lessons.length,
    scanned: idx.lessons.length,
    to_cooling: toCooling,
    to_archive: toArchive,
    untouched: idx.lessons.length - changes.length,
    changes
  };
}

function formatReport(r, dryRun) {
  const tag = dryRun ? 'DRY-RUN' : 'APPLIED';
  const lines = [
    `[${tag}] decay-lessons @ ${nowISO()}`,
    `  total=${r.total} → cooling=${r.to_cooling} archive=${r.to_archive} untouched=${r.untouched}`
  ];
  if (r.changes.length === 0) {
    lines.push('  (no lifecycle changes)');
  } else {
    for (const c of r.changes.slice(0, 20)) {
      const effTag = c.efficacy_avg !== undefined ? ` | avg=${c.efficacy_avg}` : '';
      lines.push(`  ${c.id} | ${c.from} → ${c.to} | ${c.age_days}d | reason=${c.reason}${effTag} | ${c.title.slice(0, 40)}`);
    }
    if (r.changes.length > 20) lines.push(`  ... +${r.changes.length - 20} more`);
  }
  return lines.join('\n');
}

module.exports = { decay, formatReport, COOLING_AFTER_MS, ARCHIVE_AFTER_MS };

function runSelfCheck() {
  // 临时 INDEX，跑 decay 并验证状态转移
  const tmp = path.join(BRAIN_DIR, `decay-selfcheck-${Date.now()}.json`);
  const now = Date.parse('2026-12-01T00:00:00Z');
  const fixture = {
    lessons: [
      // 永远 active（4 周前激活）
      { id: 'L-recent', lifecycle: 'active', last_activated: '2026-11-01T00:00:00Z', created: '2026-11-01T00:00:00Z', title: '最近的 active' },
      // 应转 cooling（4 个月前激活）
      { id: 'L-old-active', lifecycle: 'active', last_activated: '2026-08-01T00:00:00Z', created: '2026-08-01T00:00:00Z', title: '该 cooling 的' },
      // cooling 但未到 archive（4 个月前）
      { id: 'L-cooling-young', lifecycle: 'cooling', last_activated: '2026-08-01T00:00:00Z', created: '2026-08-01T00:00:00Z', title: '还在 cooling' },
      // cooling 应转 archive（7 个月前）
      { id: 'L-cooling-old', lifecycle: 'cooling', last_activated: '2026-05-01T00:00:00Z', created: '2026-05-01T00:00:00Z', title: '该 archive 的' },
      // archive 不动
      { id: 'L-archived', lifecycle: 'archive', last_activated: '2025-01-01T00:00:00Z', created: '2025-01-01T00:00:00Z', title: '已 archive' },
      // 老数据没 lifecycle → 兜底 active，但太老 → cooling
      { id: 'L-no-lifecycle', last_activated: '2026-08-01T00:00:00Z', created: '2026-08-01T00:00:00Z', title: '无 lifecycle 字段' },
      // IDENTITY 类（high + confirmed）走 ×2 阈值：4 个月前的 active 不该被降级
      { id: 'L-identity-young', lifecycle: 'active', severity: 'high', status: 'confirmed',
        last_activated: '2026-08-01T00:00:00Z', created: '2026-08-01T00:00:00Z', title: '身份级常识' },
      // IDENTITY 类 7 个月前 → 也不该被 archive（×2 后阈值 = 360 天）
      { id: 'L-identity-mid', lifecycle: 'cooling', severity: 'high', status: 'confirmed',
        last_activated: '2026-05-01T00:00:00Z', created: '2026-05-01T00:00:00Z', title: '身份级且 cooling 也别 archive' },
      // sanity guard：没 last_activated 也没 created → last=0，应跳过
      { id: 'L-no-timestamps', lifecycle: 'active', title: '无时间戳' },
      // v8 疗效通道 case 1：才 30 天新（远小于 90 天阈值），但激活 5+ 次 avg=0.4<0.5 → 该被强制 cooling
      { id: 'L-efficacy-low', lifecycle: 'active', last_activated: '2026-11-01T00:00:00Z', created: '2026-11-01T00:00:00Z',
        title: '疗效低教训', efficacy: { sessions: 5, score_sum: 2.0, last_scores: [] } },
      // v8 疗效通道 case 2：4 个月前（超过普通 90 天阈值），但 avg=0.9≥0.8 → 享受 ×2 保护，不该被 90 天阈值降级
      { id: 'L-efficacy-high-protected', lifecycle: 'active', last_activated: '2026-08-01T00:00:00Z', created: '2026-08-01T00:00:00Z',
        title: '疗效高教训', efficacy: { sessions: 5, score_sum: 4.5, last_scores: [] } },
      // v8 验收修 case：identity 级（high+confirmed）即便疗效低也豁免 efficacy_low 降级
      { id: 'L-efficacy-low-identity', lifecycle: 'active', severity: 'high', status: 'confirmed',
        last_activated: '2026-11-01T00:00:00Z', created: '2026-11-01T00:00:00Z',
        title: '身份级低疗效也不降', efficacy: { sessions: 5, score_sum: 2.0, last_scores: [] } }
    ]
  };
  fs.writeFileSync(tmp, JSON.stringify(fixture));

  const r1 = decay(tmp, { dryRun: true, now });
  // 应转 cooling 的: L-old-active + L-no-lifecycle + L-efficacy-low = 3（identity/疗效高同样超龄但有保护）
  // 应转 archive 的: L-cooling-old = 1（identity 同样 7 月前但有保护）
  // L-no-timestamps 应跳过 sanity guard；L-efficacy-high-protected 应受保护不降级
  if (r1.to_cooling !== 3) throw new Error(`dry-run cooling expect 3 got ${r1.to_cooling}`);
  if (r1.to_archive !== 1) throw new Error(`dry-run archive expect 1 got ${r1.to_archive}`);

  // dry-run 不应改文件
  const afterDry = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
  if (afterDry.lessons.find(l => l.id === 'L-old-active').lifecycle !== 'active') {
    throw new Error('dry-run mutated file');
  }
  console.log(`PASS | dry-run: cooling=3 archive=1, file untouched`);

  const r2 = decay(tmp, { dryRun: false, now });
  if (r2.to_cooling !== 3 || r2.to_archive !== 1) {
    throw new Error('applied counts wrong');
  }
  const after = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
  const get = (id) => after.lessons.find(l => l.id === id);
  if (get('L-recent').lifecycle !== 'active') throw new Error('L-recent should stay active');
  if (get('L-old-active').lifecycle !== 'cooling') throw new Error('L-old-active should be cooling');
  if (get('L-cooling-young').lifecycle !== 'cooling') throw new Error('L-cooling-young should stay cooling');
  if (get('L-cooling-old').lifecycle !== 'archive') throw new Error('L-cooling-old should be archive');
  if (get('L-archived').lifecycle !== 'archive') throw new Error('L-archived should stay archive');
  if (get('L-no-lifecycle').lifecycle !== 'cooling') throw new Error('no-lifecycle should be treated as active → cooling');
  // IDENTITY 保护：high+confirmed 走 ×2 阈值，4 月前的 active 不动、7 月前的 cooling 不动
  if (get('L-identity-young').lifecycle !== 'active') throw new Error('identity 4mo active should NOT be cooling-ed');
  if (get('L-identity-mid').lifecycle !== 'cooling') throw new Error('identity 7mo cooling should NOT be archived');
  // sanity guard：无时间戳的 lesson 保持原状不动
  if (get('L-no-timestamps').lifecycle !== 'active') throw new Error('no-timestamps lesson should be untouched');
  // v8 疗效通道：低疗效强制降 cooling（即便才 30 天新）；高疗效受保护不被 90 天阈值降
  if (get('L-efficacy-low').lifecycle !== 'cooling') throw new Error('low efficacy should force cooling despite recency');
  if (get('L-efficacy-high-protected').lifecycle !== 'active') throw new Error('high efficacy should be protected from 90-day cooling');
  const effLowChange = r2.changes.find(c => c.id === 'L-efficacy-low');
  if (!effLowChange || effLowChange.reason !== 'efficacy_low') throw new Error('L-efficacy-low change reason should be efficacy_low');
  // v8 验收修：identity 级低疗效豁免 efficacy_low 通道，保持 active
  if (get('L-efficacy-low-identity').lifecycle !== 'active') throw new Error('identity lesson should be exempt from efficacy_low demotion');
  console.log(`PASS | applied + identity/efficacy protection + sanity guard: 12 lessons transitioned correctly`);

  // 重跑应该 no-op（idempotent）
  const r3 = decay(tmp, { dryRun: false, now });
  if (r3.to_cooling !== 0 || r3.to_archive !== 0) {
    throw new Error('re-run should be no-op');
  }
  console.log(`PASS | idempotent: re-run produces 0 changes`);

  fs.unlinkSync(tmp);
  console.log(`\nself-check: 4 pass`);
}
