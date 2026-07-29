#!/usr/bin/env node
/**
 * analyze-behavior.js — claude-brain v8 F 行为数据分析（一次性工具）
 *
 * 扫 state/behavior-*.json，产出：
 *   总数 / score 分布直方图(0.0-0.3/0.3-0.5/0.5-0.7/0.7-1.0) /
 *   三条扣分规则各自命中率 / step 分布 / validation_ratio 分布
 * 纯读，不改任何 state 文件。
 *
 * Usage:
 *   node analyze-behavior.js               # 报告写到 BRAIN_DIR/state/behavior-analysis-<date>.md
 *   node analyze-behavior.js --out <path>  # 报告写到指定路径（覆盖默认路径）
 */

const fs = require('fs');
const path = require('path');
const { BRAIN_DIR } = require('./util.js');

let trackBehavior = null;
try { trackBehavior = require('./track-behavior.js'); } catch {}

const STATE_DIR = path.join(BRAIN_DIR, 'state');

// 发布版脱敏：不再硬编码具体用户的工作目录路径。
// 默认写回 BRAIN_DIR 自己的 state/ 下（零外部依赖）；也可用 --out 显式指定。
function resolveReportPath(argv) {
  const outIdx = argv.indexOf('--out');
  if (outIdx !== -1 && argv[outIdx + 1]) return argv[outIdx + 1];
  const dateStr = new Date().toISOString().slice(0, 10);
  return path.join(STATE_DIR, `behavior-analysis-${dateStr}.md`);
}

if (require.main === module) {
  const REPORT_PATH = resolveReportPath(process.argv.slice(2));
  const report = analyze();
  console.log(report.markdown);
  try {
    fs.writeFileSync(REPORT_PATH, report.markdown);
    console.log(`\n报告已写入: ${REPORT_PATH}`);
  } catch (e) {
    console.error('写报告文件失败:', e.message);
  }
  process.exit(0);
}

function bucketFor(score) {
  if (score < 0.3) return '0.0-0.3';
  if (score < 0.5) return '0.3-0.5';
  if (score < 0.7) return '0.5-0.7';
  return '0.7-1.0';
}

function pct(n, denom) {
  if (!denom) return '0.0%';
  return `${((n / denom) * 100).toFixed(1)}%`;
}

/**
 * 纯读分析，不写任何 state 文件
 * @returns {{ markdown: string, stats: object }}
 */
function analyze() {
  let files = [];
  try {
    files = fs.readdirSync(STATE_DIR).filter(f => f.startsWith('behavior-') && f.endsWith('.json'));
  } catch { files = []; }

  const states = [];
  for (const f of files) {
    try {
      states.push(JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf-8')));
    } catch { /* 单个坏文件不影响整体统计 */ }
  }

  const total = states.length;
  const scoreBuckets = { '0.0-0.3': 0, '0.3-0.5': 0, '0.5-0.7': 0, '0.7-1.0': 0 };
  let scored = 0;
  let hitFirstWrite = 0, hitValidation = 0, hitRetry = 0;

  const stepRanges = [[0, 3], [4, 6], [7, 10], [11, 20], [21, Infinity]];
  const stepCounts = stepRanges.map(() => 0);
  const validationRatioBuckets = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };

  for (const s of states) {
    const step = s.step || 0;

    // step 分布
    for (let i = 0; i < stepRanges.length; i++) {
      const [lo, hi] = stepRanges[i];
      if (step >= lo && step <= hi) { stepCounts[i]++; break; }
    }

    // validation_ratio 分布
    const ratio = step > 0 ? (s.validation_count || 0) / step : 0;
    if (ratio < 0.2) validationRatioBuckets['0.0-0.2']++;
    else if (ratio < 0.4) validationRatioBuckets['0.2-0.4']++;
    else if (ratio < 0.6) validationRatioBuckets['0.4-0.6']++;
    else if (ratio < 0.8) validationRatioBuckets['0.6-0.8']++;
    else validationRatioBuckets['0.8-1.0']++;

    // 三条扣分规则命中率（只统计够格评分的 session，step>=4，对齐 computeScore 的评分门槛）
    if (step >= 4) {
      if (s.first_write_step !== null && s.first_write_step !== undefined && s.first_write_step <= 2) hitFirstWrite++;
      if (ratio < 0.2) hitValidation++;
      if ((s.consecutive_retry_max || 0) >= 5) hitRetry++;
    }

    // score 分布
    const score = trackBehavior ? trackBehavior.computeScore(s) : null;
    if (score !== null && typeof score === 'number') {
      scored++;
      scoreBuckets[bucketFor(score)]++;
    }
  }

  const lines = [];
  lines.push(`# behavior state 分析（${new Date().toISOString()}）`);
  lines.push('');
  lines.push(`总 session 数: ${total}`);
  lines.push(`可评分 session 数（step>=4）: ${scored}`);
  lines.push('');
  lines.push('## score 分布');
  for (const k of ['0.0-0.3', '0.3-0.5', '0.5-0.7', '0.7-1.0']) {
    lines.push(`- ${k}: ${scoreBuckets[k]} (${pct(scoreBuckets[k], scored)})`);
  }
  lines.push('');
  lines.push('## 三条扣分规则命中率（分母 = 可评分 session 数）');
  lines.push(`- first_write_step<=2（过早动手）: ${hitFirstWrite} (${pct(hitFirstWrite, scored)})`);
  lines.push(`- validation_ratio<0.2（不验证）: ${hitValidation} (${pct(hitValidation, scored)})`);
  lines.push(`- consecutive_retry_max>=5（卡同一工具）: ${hitRetry} (${pct(hitRetry, scored)})`);
  lines.push('');
  lines.push('## step 分布');
  stepRanges.forEach(([lo, hi], i) => {
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
    lines.push(`- ${label}: ${stepCounts[i]} (${pct(stepCounts[i], total)})`);
  });
  lines.push('');
  lines.push('## validation_ratio 分布');
  for (const k of ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0']) {
    lines.push(`- ${k}: ${validationRatioBuckets[k]} (${pct(validationRatioBuckets[k], total)})`);
  }

  const markdown = lines.join('\n') + '\n';
  return {
    markdown,
    stats: { total, scored, scoreBuckets, hitFirstWrite, hitValidation, hitRetry, stepCounts, validationRatioBuckets }
  };
}

module.exports = { analyze };
