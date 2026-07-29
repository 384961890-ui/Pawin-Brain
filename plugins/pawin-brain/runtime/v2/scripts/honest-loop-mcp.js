#!/usr/bin/env node
/**
 * honest-loop-mcp.js — MCP server 暴露 brain v2 诚实回路给 cc 主动调用
 *
 * 注册位置: ~/.claude/.mcp-honest-loop.json (或主 .claude.json mcpServers)
 *
 * 暴露工具:
 *   - honest_check(query, draft_answer, p_say) → 跑完整 fuse (5源+adversary)
 *   - adversary_probe(query, draft_answer) → 单独跑 adversary
 *   - pattern_check(text) → PATTERN 触发检查
 *   - audit_stats() → 当前 brain v2 状态统计
 *
 * 用途:
 *   我（cc）做事实性断言前主动调 honest_check，看 P_true。
 *   做决策前可以调 adversary_probe 让独立 LLM 挑刺。
 */

// 借用 .claude/scripts/ 下已经装的 MCP SDK
const path = require('path');
const os = require('os');

const SDK_PATHS = [path.join(os.homedir(), '.claude/scripts')];

function smartRequire(modulePath) {
  try {
    const resolved = require.resolve(modulePath, { paths: SDK_PATHS });
    return require(resolved);
  } catch (e) {
    // fallback to standard require
    return require(modulePath);
  }
}

const { McpServer } = smartRequire('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = smartRequire('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = smartRequire('zod');

const fs = require('fs');
const { spawnSync } = require('child_process');

const V2_DIR = path.join(os.homedir(), '.claude-brain/v2');
const FUSE_JS = path.join(V2_DIR, 'scripts/honest-loop/fuse.js');
const ADV_JS = path.join(V2_DIR, 'scripts/honest-loop/adversarial-probe.js');
const AUDIT_LOG = path.join(V2_DIR, 'data/audit-log.jsonl');
const PENDING = path.join(V2_DIR, 'data/pending-review.json');
const CALIB = path.join(V2_DIR, 'data/calibration.json');

// ============================================================
// 同 fuse.js 的 PATTERN_RULES — 这里精简（不要让 MCP 依赖 fuse 内部）
// ============================================================

const PATTERN_RULES = {
  'Pattern-001': { name: '时间断言', test: (t) => /现在.{0,3}\d{1,2}.{0,3}[点时分]|已经.{0,3}\d+.{0,3}天|刚才.{0,3}\d+.{0,3}分钟/.test(t) },
  'Pattern-002': { name: 'cutoff 后产品事实', test: (t) => {
    const hasProduct = /deepseek|qwen|claude|gpt|llama|gemini|sonnet|opus|haiku/i.test(t);
    const hasYear = /202[5-9]|203\d/.test(t);
    const hasFactWord = /开源|闭源|发布|上线|支持|不支持/i.test(t);
    return hasProduct && (hasYear || hasFactWord);
  }},
  'Pattern-003': { name: '绝对否定', test: (t) => /(不能|不支持|不会|不可能|没有|永远)/.test(t) && t.length > 20 },
  'Pattern-004': { name: '没实测就报"修好"', test: (t) => /(已经)?(修好|搞定|完成|跑通)了?[。！]?$/m.test(t) },
};

// ============================================================
// Tool implementations
// ============================================================

function runFuse(query, draftAnswer, pSay) {
  const result = spawnSync('node', [FUSE_JS], {
    input: JSON.stringify({ query, draft_answer: draftAnswer, p_say: pSay }),
    timeout: 60000,
    encoding: 'utf8',
  });

  if (result.status !== 0 || !result.stdout) {
    return { error: result.stderr?.slice(0, 500) || 'fuse failed' };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: 'fuse invalid output' };
  }
}

function runAdversary(query, draftAnswer) {
  const result = spawnSync('node', [ADV_JS], {
    input: JSON.stringify({ query, draft_answer: draftAnswer }),
    timeout: 60000,
    encoding: 'utf8',
  });

  if (result.status !== 0 || !result.stdout) {
    return { error: result.stderr?.slice(0, 500) || 'adversary failed' };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: 'adversary invalid output' };
  }
}

function checkPatterns(text) {
  const matched = [];
  for (const [id, rule] of Object.entries(PATTERN_RULES)) {
    if (rule.test(text)) {
      matched.push({ id, name: rule.name });
    }
  }
  return matched;
}

function getAuditStats() {
  const stats = {
    audit_log_entries: 0,
    pending_total: 0,
    pending_evaluated: 0,
    calibrations: {},
    event_counts: {},
    last_events: [],
  };

  // audit-log 统计
  try {
    const lines = fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(l => l.trim());
    stats.audit_log_entries = lines.length;
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        const ev = e.event || 'unknown';
        stats.event_counts[ev] = (stats.event_counts[ev] || 0) + 1;
      } catch (_) {}
    }
    stats.last_events = lines.slice(-5).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {}

  // pending
  try {
    const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    stats.pending_total = pending.pending?.length || 0;
    stats.pending_evaluated = (pending.pending || []).filter(p => p.evaluated).length;
  } catch (_) {}

  // calibration
  try {
    stats.calibrations = JSON.parse(fs.readFileSync(CALIB, 'utf8'));
  } catch (_) {}

  return stats;
}

// ============================================================
// MCP Server
// ============================================================

const server = new McpServer({
  name: 'honest-loop',
  version: '0.1.0',
});

server.registerTool(
  'honest_check',
  {
    title: 'Honest Loop — 完整诚实回路检查',
    description: '对一个事实性断言跑完整 5 源置信度融合 + adversary。返回 p_true、决策、自欺差距。耗时约 15-20s（包含 WebSearch + 3 次 LLM）。**用在: 做高风险断言前主动调用。**',
    inputSchema: {
      query: z.string().describe('用户的原始问题'),
      draft_answer: z.string().describe('你打算说的答案'),
      p_say: z.number().min(0).max(1).default(0.9).describe('你口头自信度 0-1（默认 0.9）'),
    },
  },
  async ({ query, draft_answer, p_say }) => {
    const result = runFuse(query, draft_answer, p_say);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.registerTool(
  'adversary_probe',
  {
    title: 'Adversarial Probe — 独立质疑者',
    description: '只跑 adversarial probe（更快，约 5s）。让独立 DeepSeek 当"质疑者"找你答案的错误点。返回 verdict (ship/warn/block) + concerns 列表 + suggested_revision。',
    inputSchema: {
      query: z.string().describe('用户的原始问题'),
      draft_answer: z.string().describe('你打算说的答案'),
    },
  },
  async ({ query, draft_answer }) => {
    const result = runAdversary(query, draft_answer);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.registerTool(
  'pattern_check',
  {
    title: 'PATTERN 触发检查',
    description: '快速（<10ms）查一段文本命中哪些已知错误模式（时间断言/cutoff产品/绝对否定/没实测就报修好）。用在: 自我审视当前 draft 前的轻量提醒。',
    inputSchema: {
      text: z.string().describe('要检查的文本'),
    },
  },
  async ({ text }) => {
    const matched = checkPatterns(text);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matched_count: matched.length,
          patterns: matched,
          recommendation: matched.length >= 2
            ? '⚠️ 命中多个 PATTERN — 强烈建议调 honest_check'
            : matched.length === 1
            ? '命中 1 个 PATTERN — 建议加修饰词'
            : '无 PATTERN 触发',
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  'audit_stats',
  {
    title: 'Brain v2 状态统计',
    description: '看 brain v2 当前状态: audit-log 累积、pending-review 数量、calibration 系数、最近事件。无参数。',
    inputSchema: {},
  },
  async () => {
    const stats = getAuditStats();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(stats, null, 2),
      }],
    };
  }
);

// ============================================================
// Start
// ============================================================

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('honest-loop-mcp failed to start:', err);
  process.exit(1);
});
