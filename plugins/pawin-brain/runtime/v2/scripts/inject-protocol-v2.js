#!/usr/bin/env node
/**
 * inject-protocol-v2.js — claude-brain v2 诚实回路 Protocol 注入器
 *
 * Hook: UserPromptSubmit (作为 v1 inject-context.js 之后的第二注入)
 *
 * 输入: stdin JSON { prompt, session_id, ... }
 * 输出: stdout JSON { decision: "approve", additionalContext: "<honest-loop-protocol>..." }
 *
 * 失败策略: 静默退出，绝不阻塞主流程
 */

const fs = require('fs');
const path = require('path');

const V2_DIR = path.join(process.env.HOME, '.claude-brain/v2');
const PROTOCOL_PATH = path.join(V2_DIR, 'protocol.md');

// ============================================================
// 触发条件 — 用户 prompt 是否需要注入 protocol
// ============================================================
// Protocol 不是每次都注入 — 只在用户问题可能引发事实性断言时注入
// 这样避免 protocol 文本污染所有日常对话

const FACTUAL_TRIGGERS = [
  // 中英文产品/技术问询
  /是什么|什么是|怎么|如何|为什么|哪个|什么时候|发布|开源|闭源|支持|不支持|版本/,
  /what is|how to|why|when|release|open[- ]?source|support|version/i,
  // 推荐/对比
  /推荐|哪个好|对比|vs|比较|谁更|更猛|更强/,
  /recommend|compare|better|stronger/i,
  // 内存/规格/性能
  /多少|占用|大小|参数|内存|gb|mb|token/i,
  // 时间相关
  /2024|2025|2026|去年|今年|最新/,
];

function shouldInject(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  if (prompt.length < 8) return false;  // 太短的不注入
  return FACTUAL_TRIGGERS.some(re => re.test(prompt));
}

// ============================================================
// 加载 protocol.md 的关键部分（不全文注入 — 太长）
// ============================================================

function buildProtocolInjection(prompt) {
  const lines = [
    '<honest-loop-protocol>',
    '> 🪞 brain v2 诚实回路 — 这次问题命中事实性触发。',
    '',
    '**断言前自检（5 源置信度）：**',
    '1. 语言：我口头多确定？',
    '2. 一致性：换个问法答案会变吗？',
    '3. 跨模型：DeepSeek/Haiku 会同意吗？',
    '4. logprobs：训练数据覆盖这个吗？',
    '5. 历史：这类断言我历史准确率多少？',
    '',
    '**自欺检测：** 如果口头确定度 >> 真实置信度 → 停 → 改写。',
    '',
    '**三档决策：**',
    '- P≥85%: 正常答（不用"绝对/必须/永远"）',
    '- 50-85%: 加修饰（"我记得/应该是"）+ 简短缘由',
    '- <50%: 不直接答 → WebSearch / 反问 / haiku verify',
    '',
    '**今天的反例提醒：** 昨天我说"DeepSeek V4 Pro 闭源" — 错的。MIT License 公开。',
    '触发的根因：训练数据没覆盖 + 没自检 + 自信地编。',
    '',
    '> 完整 protocol: ~/.claude-brain/v2/protocol.md',
    '</honest-loop-protocol>',
  ];
  return lines.join('\n');
}

// ============================================================
// 审计日志 — 每次注入记一条
// ============================================================

const AUDIT_LOG = path.join(V2_DIR, 'data/audit-log.jsonl');

function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch (e) {
    // 静默失败
  }
}

// ============================================================
// 主流程
// ============================================================

function main() {
  let input = '';
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input || '{}');
      const prompt = data.prompt || data.user_message || '';

      if (!shouldInject(prompt)) {
        // 不注入 — 但记一条审计
        appendAudit({
          ts: new Date().toISOString(),
          event: 'inject_skipped',
          prompt_preview: prompt.slice(0, 80),
          reason: 'no_factual_trigger',
        });
        process.exit(0);
      }

      const injection = buildProtocolInjection(prompt);

      const output = {
        decision: 'approve',
        additionalContext: injection,
      };

      appendAudit({
        ts: new Date().toISOString(),
        event: 'protocol_injected',
        prompt_preview: prompt.slice(0, 80),
        injection_len: injection.length,
      });

      process.stdout.write(JSON.stringify(output));
    } catch (e) {
      // 静默失败 — 不阻塞主流程
      appendAudit({
        ts: new Date().toISOString(),
        event: 'inject_error',
        error: e.message,
      });
      process.exit(0);
    }
  });
}

main();
