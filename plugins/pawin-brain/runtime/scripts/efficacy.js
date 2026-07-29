#!/usr/bin/env node
/**
 * efficacy.js — claude-brain v8 疗效归因
 *
 * 职责：把 session 的最终行为分挂回该 session 激活过的 lessons。
 * 治的缺口：行为分在算(track-behavior.js)、激活记录在写(inject-context.js)，
 *          但两者从没对上——没人知道"给了这条教训的 session 表现是好是坏"。
 *
 * 记账时机（关键设计 不许改）：
 *   不在每轮 Stop 记（Stop 每轮对话都触发，session 没死、分数没定，会重复计）。
 *   而是搭 capture-lesson.js 末尾 cleanupOldStates 的顺风车——
 *   清 7 天前的 behavior state 文件时，那个 session 必然已死，behavior 分是终值。
 *   删文件前先归因，删完自然幂等。
 *
 * 一切 IO 都吞错误，不阻塞主流程（Stop hook 顺手调用）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BRAIN_DIR, loadConfig, readFileSafe, writeFileAtomic, nowISO, debugLog
} = require('./util.js');

// 复用 track-behavior 的 computeScore（require 守卫不会自爆，模块被 require 时不跑 stdin 副作用）
let trackBehavior = null;
try { trackBehavior = require('./track-behavior.js'); } catch {}

const config = loadConfig();

const STATE_DIR = path.join(BRAIN_DIR, 'state');
const INDEX_PATH = path.join(BRAIN_DIR, 'lessons/INDEX.json');
// TTL 沿用 track-behavior 的 7 天；模块加载失败时本地兜底同值
const DEFAULT_TTL_MS = (trackBehavior && trackBehavior.STATE_TTL_MS) || 7 * 24 * 3600 * 1000;

if (require.main === module) {
  if (process.argv.includes('--self-check')) {
    runSelfCheck();
    process.exit(0);
  }
}

function behaviorPath(stateDir, sessionId) {
  return path.join(stateDir, `behavior-${sessionId}.json`);
}
function activatedPath(stateDir, sessionId) {
  return path.join(stateDir, `activated-${sessionId}.json`);
}

/**
 * settleSession(sessionId, opts) — 单个 session 结账
 * @param {string} sessionId
 * @param {{ stateDir?: string, indexPath?: string }} opts 测试用注入点，生产走默认值
 * @returns {{ settled: boolean, score: number|null, lessons_updated: number }}
 */
function settleSession(sessionId, opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  const indexPath = opts.indexPath || INDEX_PATH;

  // 1. 算终分：behavior 文件不存在或 step<4（computeScore 内部已判）→ null
  //    样本太短不算疗效，但仍算 settled（不是失败，只是没数据）
  let score = null;
  const bPath = behaviorPath(stateDir, sessionId);
  if (fs.existsSync(bPath)) {
    try {
      const state = JSON.parse(fs.readFileSync(bPath, 'utf-8'));
      if (trackBehavior && typeof trackBehavior.computeScore === 'function') {
        score = trackBehavior.computeScore(state);
      }
    } catch (e) {
      debugLog(config, 'efficacy: bad behavior state', sessionId, e.message);
    }
  }

  // 2. 读激活过的 lesson ids；不存在 → 无事可记，直接返回（score 仍如实反映）
  const aPath = activatedPath(stateDir, sessionId);
  if (!fs.existsSync(aPath)) {
    return { settled: true, score, lessons_updated: 0 };
  }
  let lessonIds = [];
  try {
    const parsed = JSON.parse(readFileSafe(aPath, '[]'));
    if (Array.isArray(parsed)) lessonIds = parsed;
  } catch (e) {
    debugLog(config, 'efficacy: bad activated file', sessionId, e.message);
  }

  if (score === null || lessonIds.length === 0) {
    return { settled: true, score, lessons_updated: 0 };
  }

  // 3. 挂回 INDEX.json：对每条被激活过的 lesson 累计 efficacy
  let idx;
  try { idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}')); }
  catch (e) {
    debugLog(config, 'efficacy: bad index', e.message);
    return { settled: true, score, lessons_updated: 0 };
  }
  if (!Array.isArray(idx.lessons)) idx.lessons = [];

  const idSet = new Set(lessonIds);
  let updated = 0;
  for (const l of idx.lessons) {
    if (!idSet.has(l.id)) continue;
    if (!l.efficacy || typeof l.efficacy !== 'object') {
      l.efficacy = { sessions: 0, score_sum: 0, last_scores: [] };
    }
    l.efficacy.sessions = (l.efficacy.sessions || 0) + 1;
    l.efficacy.score_sum = (l.efficacy.score_sum || 0) + score;
    const scores = Array.isArray(l.efficacy.last_scores) ? l.efficacy.last_scores : [];
    scores.push(score);
    l.efficacy.last_scores = scores.slice(-10); // 只留最近 10 个
    l.efficacy.updated = nowISO();
    updated++;
  }

  // 4. 写回
  if (updated > 0) {
    try { writeFileAtomic(indexPath, JSON.stringify(idx, null, 2)); }
    catch (e) { debugLog(config, 'efficacy: write index failed', e.message); }
  }

  return { settled: true, score, lessons_updated: updated };
}

/**
 * settleAndCleanup(ttlMs, opts) — capture-lesson.js 调的总入口
 * 扫 state/ 下所有 behavior-*.json，mtime 超过 ttlMs 的：
 *   先 settleSession(sid)，再删 behavior-<sid>.json 和 activated-<sid>.json
 * 顺手清掉没有对应 behavior 文件、自身也超龄的孤儿 activated-*.json
 * （老版本 cleanupOldStates 只清 behavior，留下的历史孤儿）
 * @param {number} [ttlMs] 默认沿用 DEFAULT_TTL_MS（7天）
 * @param {{ stateDir?: string, indexPath?: string }} [opts] 测试用注入点
 * @returns {{ settled: number, cleaned: number }}
 */
function settleAndCleanup(ttlMs, opts = {}) {
  const stateDir = opts.stateDir || STATE_DIR;
  const indexPath = opts.indexPath || INDEX_PATH;
  const maxAgeMs = ttlMs || DEFAULT_TTL_MS;

  let settled = 0;
  let cleaned = 0;
  if (!fs.existsSync(stateDir)) return { settled, cleaned };

  let entries;
  try { entries = fs.readdirSync(stateDir); } catch { return { settled, cleaned }; }

  const now = Date.now();
  const handledSids = new Set();

  for (const f of entries) {
    if (!f.startsWith('behavior-') || !f.endsWith('.json')) continue;
    const sid = f.slice('behavior-'.length, -'.json'.length);
    const p = path.join(stateDir, f);
    let mtimeMs;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
    if (now - mtimeMs <= maxAgeMs) continue; // 未到期，不动

    try {
      settleSession(sid, { stateDir, indexPath });
      settled++;
    } catch (e) {
      debugLog(config, 'efficacy: settleSession failed', sid, e.message);
    }
    handledSids.add(sid);

    try { fs.unlinkSync(p); cleaned++; } catch {}
    const aPath = activatedPath(stateDir, sid);
    try { if (fs.existsSync(aPath)) { fs.unlinkSync(aPath); cleaned++; } } catch {}
  }

  // 孤儿 activated-*.json：没有对应 behavior 文件（历史遗留），自身超龄就直接清
  for (const f of entries) {
    if (!f.startsWith('activated-') || !f.endsWith('.json')) continue;
    const sid = f.slice('activated-'.length, -'.json'.length);
    if (handledSids.has(sid)) continue;
    const bPath = behaviorPath(stateDir, sid);
    if (fs.existsSync(bPath)) continue; // 有对应 behavior 文件，交给上面那轮处理
    const p = path.join(stateDir, f);
    let mtimeMs;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
    if (now - mtimeMs <= maxAgeMs) continue;
    try { fs.unlinkSync(p); cleaned++; } catch {}
  }

  return { settled, cleaned };
}

module.exports = { settleSession, settleAndCleanup, behaviorPath, activatedPath };

/**
 * 自检：跑 `node efficacy.js --self-check`
 * 全程用 os.tmpdir() 造假 state + 假 INDEX，不碰真 INDEX / 真 state
 */
function runSelfCheck() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'efficacy-selfcheck-'));
  const stateDir = path.join(tmpRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const indexPath = path.join(tmpRoot, 'INDEX.json');

  let pass = 0;
  const writeIndex = (lessons) => fs.writeFileSync(indexPath, JSON.stringify({ lessons }));
  const writeBehavior = (sid, state) =>
    fs.writeFileSync(behaviorPath(stateDir, sid), JSON.stringify(state));
  const writeActivated = (sid, ids) =>
    fs.writeFileSync(activatedPath(stateDir, sid), JSON.stringify(ids));

  // Case 1: 正常结账 — 有效 behavior + 激活 1 条存在的 lesson + 1 条不存在的 lesson（应被忽略）
  {
    const sid = 'case1';
    writeIndex([{ id: 'L-case1', title: 'x', efficacy: undefined }]);
    writeBehavior(sid, {
      session_id: sid, step: 6, first_write_step: 5,
      validation_count: 1, consecutive_retry_max: 2
    });
    writeActivated(sid, ['L-case1', 'L-not-exist']);
    const r = settleSession(sid, { stateDir, indexPath });
    if (!r.settled) throw new Error('case1: settled should be true');
    if (typeof r.score !== 'number') throw new Error('case1: score should be number');
    if (r.lessons_updated !== 1) throw new Error(`case1: lessons_updated expect 1 got ${r.lessons_updated}`);
    const after = readIndexHelper(indexPath);
    const l = after.lessons.find(x => x.id === 'L-case1');
    if (!l.efficacy) throw new Error('case1: efficacy not written');
    if (l.efficacy.sessions !== 1) throw new Error('case1: sessions should be 1');
    if (Math.abs(l.efficacy.score_sum - r.score) > 1e-9) throw new Error('case1: score_sum mismatch');
    if (l.efficacy.last_scores.length !== 1) throw new Error('case1: last_scores length should be 1');
    console.log(`PASS | case1 normal settle: score=${r.score.toFixed(2)} lessons_updated=${r.lessons_updated}`);
    pass++;
  }

  // Case 2: 样本太短（step<4）→ score=null，efficacy 不写
  {
    const sid = 'case2';
    writeIndex([{ id: 'L-case2', title: 'y' }]);
    writeBehavior(sid, { session_id: sid, step: 2, first_write_step: 1, validation_count: 0, consecutive_retry_max: 1 });
    writeActivated(sid, ['L-case2']);
    const r = settleSession(sid, { stateDir, indexPath });
    if (!r.settled) throw new Error('case2: settled should be true even with null score');
    if (r.score !== null) throw new Error(`case2: score should be null got ${r.score}`);
    if (r.lessons_updated !== 0) throw new Error('case2: lessons_updated should be 0');
    const after = readIndexHelper(indexPath);
    const l = after.lessons.find(x => x.id === 'L-case2');
    if (l.efficacy) throw new Error('case2: efficacy should not be created on null score');
    console.log(`PASS | case2 null score (step<4) not written`);
    pass++;
  }

  // Case 3: behavior 文件不存在 → score=null，settled 仍 true
  {
    const sid = 'case3-no-behavior';
    writeIndex([{ id: 'L-case3', title: 'z' }]);
    writeActivated(sid, ['L-case3']);
    const r = settleSession(sid, { stateDir, indexPath });
    if (!r.settled) throw new Error('case3: settled should be true');
    if (r.score !== null) throw new Error('case3: score should be null (no behavior file)');
    if (r.lessons_updated !== 0) throw new Error('case3: lessons_updated should be 0');
    console.log(`PASS | case3 missing behavior file → score=null`);
    pass++;
  }

  // Case 4: activated 文件不存在 → 无事可记，直接返回
  {
    const sid = 'case4-no-activated';
    writeIndex([{ id: 'L-case4', title: 'w' }]);
    writeBehavior(sid, { session_id: sid, step: 6, first_write_step: 4, validation_count: 2, consecutive_retry_max: 1 });
    const r = settleSession(sid, { stateDir, indexPath });
    if (!r.settled) throw new Error('case4: settled should be true');
    if (r.lessons_updated !== 0) throw new Error('case4: lessons_updated should be 0 (no activated file)');
    console.log(`PASS | case4 missing activated file → no-op returns settled`);
    pass++;
  }

  // Case 5: last_scores 截断到 10（预置 10 条历史分数，追加第 11 条应截断保留最近 10）
  {
    const sid = 'case5-truncate';
    const preScores = Array.from({ length: 10 }, () => 0.1);
    writeIndex([{
      id: 'L-case5', title: 'trunc',
      efficacy: { sessions: 10, score_sum: 1.0, last_scores: preScores, updated: nowISO() }
    }]);
    writeBehavior(sid, { session_id: sid, step: 10, first_write_step: 8, validation_count: 5, consecutive_retry_max: 1 });
    writeActivated(sid, ['L-case5']);
    const r = settleSession(sid, { stateDir, indexPath });
    const after = readIndexHelper(indexPath);
    const l = after.lessons.find(x => x.id === 'L-case5');
    if (l.efficacy.last_scores.length !== 10) throw new Error(`case5: last_scores length expect 10 got ${l.efficacy.last_scores.length}`);
    if (l.efficacy.last_scores[9] !== r.score) throw new Error('case5: last item should be new score');
    if (l.efficacy.sessions !== 11) throw new Error('case5: sessions should be 11');
    console.log(`PASS | case5 last_scores truncated to 10, sessions=${l.efficacy.sessions}`);
    pass++;
  }

  // Case 6: settleAndCleanup — 超龄的 behavior+activated 对被结账+删除；超龄孤儿 activated 也被清
  {
    const sid = 'case6-cleanup';
    writeIndex([{ id: 'L-case6', title: 'clean' }]);
    writeBehavior(sid, { session_id: sid, step: 6, first_write_step: 4, validation_count: 2, consecutive_retry_max: 1 });
    writeActivated(sid, ['L-case6']);
    const orphanSid = 'case6-orphan';
    writeActivated(orphanSid, ['L-case6']);
    // 把这三个文件的 mtime 拨到很久以前，制造"超龄"
    const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    for (const p of [behaviorPath(stateDir, sid), activatedPath(stateDir, sid), activatedPath(stateDir, orphanSid)]) {
      fs.utimesSync(p, oldTime, oldTime);
    }
    const r = settleAndCleanup(7 * 24 * 3600 * 1000, { stateDir, indexPath });
    if (r.settled !== 1) throw new Error(`case6: settled expect 1 got ${r.settled}`);
    if (r.cleaned !== 3) throw new Error(`case6: cleaned expect 3 (behavior+activated+orphan) got ${r.cleaned}`);
    if (fs.existsSync(behaviorPath(stateDir, sid))) throw new Error('case6: behavior file should be deleted');
    if (fs.existsSync(activatedPath(stateDir, sid))) throw new Error('case6: activated file should be deleted');
    if (fs.existsSync(activatedPath(stateDir, orphanSid))) throw new Error('case6: orphan activated file should be deleted');
    const after = readIndexHelper(indexPath);
    const l = after.lessons.find(x => x.id === 'L-case6');
    if (!l.efficacy || l.efficacy.sessions !== 1) throw new Error('case6: efficacy should reflect settled session');
    console.log(`PASS | case6 settleAndCleanup: settled=${r.settled} cleaned=${r.cleaned}`);
    pass++;
  }

  // 清理临时目录
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  console.log(`\nself-check: ${pass} pass`);
}

function readIndexHelper(indexPath) {
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}
