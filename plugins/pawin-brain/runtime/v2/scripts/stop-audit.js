#!/usr/bin/env node
/**
 * stop-audit.js — Stop hook 事后审计器
 *
 * 触发: 我每次 Stop（结束一轮发言）
 *
 * 做的事:
 *   1. 扫我刚说的话（从当前 session 的 jsonl 拿最后一条 assistant 消息）
 *   2. 抽事实性断言句子（用 PATTERNS 规则匹配）
 *   3. 写到 pending-review.json，等 nightly 跑完整 fuse 评估
 *   4. 高危的（命中 ≥2 个 PATTERN）实时报警到 audit-log
 *
 * 不做的事:
 *   - 不实时跑 fuse（17s 延迟用户不能忍）
 *   - 不阻塞 — 静默背景处理
 */

const fs = require('fs');
const path = require('path');

const V2_DIR = path.join(process.env.HOME, '.claude-brain/v2');
const PENDING_REVIEW = path.join(V2_DIR, 'data/pending-review.json');
const AUDIT_LOG = path.join(V2_DIR, 'data/audit-log.jsonl');

// 复用 fuse 里的 PATTERN_RULES — 这里精简
const PATTERN_RULES = {
  'Pattern-001': {
    name: '时间断言',
    test: (text) => /现在.{0,3}\d{1,2}.{0,3}[点时分]|已经.{0,3}\d+.{0,3}天|刚才.{0,3}\d+.{0,3}分钟/.test(text),
  },
  'Pattern-002': {
    name: 'cutoff 后产品事实',
    test: (text) => {
      const hasProduct = /deepseek|qwen|claude|gpt|llama|gemini|sonnet|opus|haiku/i.test(text);
      const hasYear = /202[5-9]|203\d/.test(text);
      const hasFactWord = /开源|闭源|发布|上线|支持|不支持/i.test(text);
      return hasProduct && (hasYear || hasFactWord);
    },
  },
  'Pattern-003': {
    name: '绝对否定',
    test: (text) => /(不能|不支持|不会|不可能|没有|永远)/.test(text) && text.length > 30,
  },
  'Pattern-004': {
    name: '没实测就报"修好"',
    test: (text) => /(已经)?(修好|搞定|完成|跑通)了?[。！]?$/m.test(text),
  },
};

function findFactualSentences(text) {
  // 切句子（中英文标点）
  const sentences = text.split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 400);
  const flagged = [];

  for (const s of sentences) {
    const matchedPatterns = [];
    for (const [id, rule] of Object.entries(PATTERN_RULES)) {
      if (rule.test(s)) matchedPatterns.push(id);
    }
    if (matchedPatterns.length > 0) {
      flagged.push({ sentence: s, patterns: matchedPatterns });
    }
  }

  return flagged;
}

function loadPendingReview() {
  try {
    const txt = fs.readFileSync(PENDING_REVIEW, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return { pending: [] };
  }
}

function savePendingReview(data) {
  fs.writeFileSync(PENDING_REVIEW, JSON.stringify(data, null, 2));
}

function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    // 静默
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  let input = '';
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input || '{}');

      // Stop hook 输入: { session_id, transcript_path, ... }
      const transcriptPath = data.transcript_path;
      const sessionId = data.session_id || 'unknown';

      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        process.exit(0);  // 静默退出
      }

      // 读 jsonl 最后几行找最新 assistant 消息
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim()).slice(-20);

      let lastAssistantText = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj.message || {};
          if (msg.role !== 'assistant') continue;
          const c = msg.content || [];
          if (!Array.isArray(c)) continue;
          for (const block of c) {
            if (block.type === 'text' && block.text) {
              lastAssistantText = block.text;
              break;
            }
          }
          if (lastAssistantText) break;
        } catch (e) { continue; }
      }

      if (!lastAssistantText || lastAssistantText.length < 50) {
        process.exit(0);
      }

      // 抽事实性断言
      const flagged = findFactualSentences(lastAssistantText);

      if (flagged.length === 0) {
        appendAudit({
          ts: new Date().toISOString(),
          event: 'stop_audit_clean',
          session: sessionId,
          msg_len: lastAssistantText.length,
        });
        process.exit(0);
      }

      // 写入 pending review
      const pending = loadPendingReview();
      const newItems = flagged.map(f => ({
        id: `${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        session: sessionId,
        sentence: f.sentence,
        patterns: f.patterns,
        evaluated: false,
      }));
      pending.pending.push(...newItems);

      // 限制 pending 大小（最多保留最近 500）
      if (pending.pending.length > 500) {
        pending.pending = pending.pending.slice(-500);
      }

      savePendingReview(pending);

      // 高危事件（≥2 个 PATTERN 命中）实时报警
      const highRisk = flagged.filter(f => f.patterns.length >= 2);

      appendAudit({
        ts: new Date().toISOString(),
        event: 'stop_audit_flagged',
        session: sessionId,
        flagged_count: flagged.length,
        high_risk_count: highRisk.length,
        sample: flagged[0].sentence.slice(0, 100),
        patterns: [...new Set(flagged.flatMap(f => f.patterns))],
      });

      process.exit(0);
    } catch (e) {
      appendAudit({
        ts: new Date().toISOString(),
        event: 'stop_audit_error',
        error: e.message,
      });
      process.exit(0);
    }
  });
}

main();
