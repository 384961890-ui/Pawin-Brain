#!/usr/bin/env node
/**
 * think-detect.js — claude-brain v3 卡住信号检测器（think-loop 核心 ②）
 *
 * Hook: Stop（挂在 capture-lesson 之后、update-state 之前）
 *
 * 输入: stdin JSON { session_id, transcript_path, ... }
 * 输出: 无（静默）；副作用 = 写/清 ~/.claude-brain/v3/stuck-flag.json
 *
 * 作用：读"我（assistant）"最近一轮的输出，检测"原地打转 / 单向硬磕"信号。
 *   - 命中卡住信号  → 举旗（写 stuck-flag.json）
 *   - 命中推进信号  → 降旗（删 flag，说明我在顺利收尾）
 * 下一轮 inject-context.js 读到旗 → 注入"突破清单" + 降旗。
 *
 * 为什么扫 assistant 不扫 user：
 *   卡住的人是我，"还是不行/再试一次"是我说的，不是用户说的。
 *   capture-lesson 扫 user（用户的纠正），think-detect 扫 assistant（我的打转）。互补。
 *
 * 失败策略：静默退出，绝不阻塞 Stop hook。
 */

const fs = require('fs');
const path = require('path');
const { BRAIN_DIR, loadConfig, writeFileAtomic, nowISO, debugLog } = require('../../scripts/util.js');

const config = loadConfig();
const FLAG_PATH = path.join(BRAIN_DIR, 'v3', 'stuck-flag.json');

// 我"嘴上"卡住的信号 — 收紧到明确受挫 / 重试语气（宁可漏，不可滥）
const STUCK_PATTERNS = [
  /还是(不行|不对|没用|报错|失败|不工作|没成功)/,
  /(再试|再来|再跑|重试)(一次|一遍|试试|看看)?/,
  /又(失败|报错|挂了|不行|错了|崩)/,
  /搞不定|弄不好|卡住了?|卡在|死活(不|没)/,
  /怎么(还是|又|总是?)(不|没|是|会)/,
  /换(个|种|条)(方法|思路|方式|做法|写法|路子?|招)/,
  /(这|那)(条|个)(路|方法|思路|方向)(不通|行不通|走不通)/,
];

// 我在顺利推进 / 收尾 → 强否决（不举旗 / 降旗）
const PROGRESS_PATTERNS = [
  /搞定|done|完成了?|通过了?|测(通|过)了?|跑通|成功|生效了?|可以了|没问题|齐活|搞好了?/i,
];

function extractRecentAssistantText(transcriptPath) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return ''; }

  const lines = raw.split('\n').filter(l => l.trim());
  const texts = [];

  // 末尾 60 行里找 assistant 消息的自然语言文本
  for (const line of lines.slice(-60)) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const role = msg.role || msg.type;
    if (role !== 'assistant') continue;

    let content = msg.content;
    if (msg.message && msg.message.content) content = msg.message.content;

    if (Array.isArray(content)) {
      // 只取 text 块（跳过 tool_use / thinking — 那些不是"我说的话"）
      content = content
        .filter(c => c && (c.type === 'text' || typeof c === 'string'))
        .map(c => (typeof c === 'string' ? c : c.text) || '')
        .join(' ');
    }
    if (typeof content === 'string' && content.trim()) {
      texts.push(content.trim());
    }
  }

  // 只看最近 2 条 assistant 消息（最新这一轮我说的）
  return texts.slice(-2).join('\n');
}

function raiseFlag(sessionId, signals, text) {
  try {
    const dir = path.dirname(FLAG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(FLAG_PATH, JSON.stringify({
      stuck: true,
      session_id: sessionId,
      signals,
      excerpt: text.slice(-220),
      raised_at: nowISO(),
    }, null, 2));
  } catch (e) { debugLog(config, 'raiseFlag failed:', e.message); }
}

function clearFlag() {
  try { if (fs.existsSync(FLAG_PATH)) fs.unlinkSync(FLAG_PATH); }
  catch {}
}

let stdinData = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => stdinData += c);
process.stdin.on('end', () => {
  try {
    const input = stdinData.trim() ? JSON.parse(stdinData) : {};
    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id || 'unknown';

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      debugLog(config, 'think-detect: no transcript');
      return process.exit(0);
    }

    const text = extractRecentAssistantText(transcriptPath);
    if (!text) return process.exit(0);

    // 推进信号优先 → 我在收尾，降旗退出
    if (PROGRESS_PATTERNS.some(p => p.test(text))) {
      clearFlag();
      debugLog(config, 'think-detect: progress → cleared');
      return process.exit(0);
    }

    const hits = STUCK_PATTERNS.filter(p => p.test(text)).map(p => p.source);
    if (hits.length >= 1) {
      raiseFlag(sessionId, hits, text);
      debugLog(config, `think-detect: STUCK raised (${hits.length} hits)`);
    }
  } catch (e) {
    debugLog(config, 'think-detect error:', e.message);
  }
  process.exit(0);
});
