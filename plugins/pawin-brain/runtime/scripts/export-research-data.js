#!/usr/bin/env node
/**
 * export-research-data.js — claude-brain v8 研究数据导出（志愿者专用）
 *
 * 一条命令导出论文需要的全部数据，并且只导这些：
 *   Part 1  session 行为分布（复用 analyze-behavior.js 的聚合统计）
 *   Part 2  lesson 疗效档案表（id / severity / status / lifecycle / 创建日期 /
 *           activation_count / efficacy 数字）
 *
 * 隐私边界（写死在代码里，不是承诺是实现）：
 *   - 不读也不输出 lesson 的 title / summary / raw_signal —— 那是您对话内容的提炼
 *   - 不输出 session_id / 文件路径 / 任何自由文本字段
 *   - 本地 id 含毫秒时间戳和进程 pid（时间指纹），导出前先加盐哈希成
 *     x<12位hex>；盐随机生成、只存本机（state/export-salt），同机多次导出
 *     同一 lesson 映射一致（可做纵向对齐），拿到报告的人反推不回本地 id
 *
 * Usage:
 *   node export-research-data.js                          # 默认写 ~/Desktop/brain-research-data.md
 *   node export-research-data.js --out <path>
 *   node export-research-data.js --self-check
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BRAIN_DIR, readFileSafe } = require('./util.js');

let analyzeMod = null;
try { analyzeMod = require('./analyze-behavior.js'); } catch {}

const INDEX_PATH = path.join(BRAIN_DIR, 'lessons/INDEX.json');
const SALT_PATH = path.join(BRAIN_DIR, 'state/export-salt');
// 只允许这些字段出包 —— 白名单制，新增字段默认不导出
const SAFE_FIELDS = ['id', 'severity', 'status', 'lifecycle', 'activation_count'];

/** 盐只存本机：首次导出随机生成，之后复用（同机纵向对齐，跨机不可关联） */
function loadSalt(saltPath) {
  try {
    const s = fs.readFileSync(saltPath, 'utf-8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const salt = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(saltPath), { recursive: true });
  fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}

/** 本地 id（含时间戳+pid 指纹）→ 导出用无语义标识 x<12hex> */
function anonymizeId(id, salt) {
  return 'x' + crypto.createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 12);
}

if (require.main === module) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    process.exit(0);
  }
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx > -1 && process.argv[outIdx + 1]
    ? process.argv[outIdx + 1]
    : path.join(os.homedir(), 'Desktop', 'brain-research-data.md');
  const report = buildReport(INDEX_PATH);
  fs.writeFileSync(outPath, report);
  console.log(`报告已写入: ${outPath}`);
  console.log('本报告只含聚合数字与加盐哈希 id，不含对话内容/教训文字/文件路径/本地 id。');
  console.log('请自行打开过目确认后，再通过给您发包的渠道交回。');
  process.exit(0);
}

/** 单条 lesson → 脱敏行（白名单字段 + efficacy 数字 + 日期级 created + 加盐哈希 id） */
function sanitizeLesson(l, salt) {
  const row = {};
  for (const k of SAFE_FIELDS) row[k] = l[k] !== undefined ? l[k] : null;
  // 本地 id 带毫秒时间戳+pid 是时间指纹 导出前哈希掉
  row.id = typeof l.id === 'string' ? anonymizeId(l.id, salt) : null;
  // created 降精度到日期（时间戳级精度对研究无用，还会成为指纹）
  row.created_date = typeof l.created === 'string' ? l.created.slice(0, 10) : null;
  if (l.efficacy && typeof l.efficacy === 'object') {
    row.efficacy_sessions = l.efficacy.sessions || 0;
    row.efficacy_score_sum = +(l.efficacy.score_sum || 0).toFixed(3);
    row.efficacy_last_scores = Array.isArray(l.efficacy.last_scores)
      ? l.efficacy.last_scores.map(s => +(+s).toFixed(2)) : [];
  } else {
    row.efficacy_sessions = 0;
    row.efficacy_score_sum = 0;
    row.efficacy_last_scores = [];
  }
  return row;
}

function buildReport(indexPath, saltPath = SALT_PATH) {
  const salt = loadSalt(saltPath);
  const lines = [];
  lines.push(`# brain v8 research data export (${new Date().toISOString().slice(0, 10)})`);
  lines.push('');
  lines.push('> 本报告仅含聚合数字与加盐哈希 id（x 开头 12 位 hex 无语义 无时间指纹）。不含对话内容、教训文字、文件路径、身份信息。');
  lines.push('');

  // Part 1: 行为分布（analyze-behavior 的聚合统计，本就不含自由文本）
  lines.push('## Part 1 · session 行为分布');
  lines.push('');
  if (analyzeMod && analyzeMod.analyze) {
    try {
      lines.push(analyzeMod.analyze().markdown.trim());
    } catch (e) {
      lines.push(`(行为分布生成失败: ${e.message})`);
    }
  } else {
    lines.push('(analyze-behavior.js 不可用，跳过)');
  }
  lines.push('');

  // Part 2: lesson 疗效档案（白名单字段）
  lines.push('## Part 2 · lesson 疗效档案');
  lines.push('');
  let idx;
  try { idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}')); }
  catch { idx = { lessons: [] }; }
  const lessons = Array.isArray(idx.lessons) ? idx.lessons : [];
  const rows = lessons.map(l => sanitizeLesson(l, salt));
  lines.push(`总条目: ${rows.length}，其中有疗效数据(sessions>0): ${rows.filter(r => r.efficacy_sessions > 0).length}`);
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(rows, null, 2));
  lines.push('```');
  return lines.join('\n') + '\n';
}

module.exports = { sanitizeLesson, buildReport, SAFE_FIELDS, anonymizeId, loadSalt };

/** 自检：tmp 假 INDEX，断言敏感字段绝不出现在输出里 */
function runSelfCheck() {
  const tmp = path.join(os.tmpdir(), `export-selfcheck-${process.pid}.json`);
  const tmpSalt = path.join(os.tmpdir(), `export-selfcheck-salt-${process.pid}`);
  const SECRET_TITLE = 'SECRET-TITLE-MUST-NOT-LEAK';
  const SECRET_SUMMARY = 'SECRET-SUMMARY-MUST-NOT-LEAK';
  const SECRET_RAW = 'SECRET-RAW-MUST-NOT-LEAK';
  const SECRET_SID = 'SECRET-SESSION-ID';
  fs.writeFileSync(tmp, JSON.stringify({
    lessons: [
      { id: 'L-1', title: SECRET_TITLE, summary: SECRET_SUMMARY, raw_signal: SECRET_RAW,
        session_id: SECRET_SID, severity: 'high', status: 'confirmed', lifecycle: 'active',
        created: '2026-07-01T12:34:56.789Z', activation_count: 7,
        efficacy: { sessions: 5, score_sum: 3.14159, last_scores: [0.7, 0.8, 0.55555] } },
      { id: 'L-2', title: SECRET_TITLE, severity: 'mid', status: 'draft' } // 无 efficacy 的兜底
    ]
  }));

  let pass = 0;
  const report = buildReport(tmp, tmpSalt);

  for (const secret of [SECRET_TITLE, SECRET_SUMMARY, SECRET_RAW, SECRET_SID]) {
    if (report.includes(secret)) throw new Error(`LEAK: ${secret} appeared in report`);
  }
  console.log('PASS | 敏感字段(title/summary/raw_signal/session_id)零泄漏');
  pass++;

  // id 加盐哈希：本地 id 不出现、映射稳定、不同 lesson 不同哈希
  if (report.includes('"id": "L-')) throw new Error('LEAK: raw lesson id appeared in report');
  const report2 = buildReport(tmp, tmpSalt);
  const idsOf = r => JSON.parse(r.split('```json')[1].split('```')[0]).map(x => x.id);
  const [ids1, ids2] = [idsOf(report), idsOf(report2)];
  if (JSON.stringify(ids1) !== JSON.stringify(ids2)) throw new Error('salted id mapping unstable across exports');
  if (new Set(ids1).size !== ids1.length) throw new Error('distinct lessons collided to same hash');
  if (!ids1.every(i => /^x[0-9a-f]{12}$/.test(i))) throw new Error('exported id not x<12hex> shape');
  console.log('PASS | id 加盐哈希：本地 id 零出现、同机映射稳定、无碰撞');
  pass++;

  if (!report.includes('"efficacy_sessions": 5')) throw new Error('efficacy numbers missing');
  if (!report.includes('"created_date": "2026-07-01"')) throw new Error('created not date-truncated');
  if (report.includes('12:34:56')) throw new Error('created timestamp precision leaked');
  console.log('PASS | efficacy 数字在、created 降到日期级');
  pass++;

  const hashedL2 = anonymizeId('L-2', loadSalt(tmpSalt));
  const row2 = JSON.parse(report.split('```json')[1].split('```')[0]).find(r => r.id === hashedL2);
  if (row2.efficacy_sessions !== 0 || row2.efficacy_last_scores.length !== 0) {
    throw new Error('missing-efficacy fallback wrong');
  }
  console.log('PASS | 无 efficacy 条目兜底为 0/[]');
  pass++;

  fs.unlinkSync(tmp);
  fs.unlinkSync(tmpSalt);
  console.log(`\nself-check: ${pass} pass`);
}
