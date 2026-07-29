#!/usr/bin/env node
/**
 * adversarial-probe.js — 结构独立的质疑者
 *
 * 学术对应:
 *   - "Adversarial self-verification (deliberately probing weak points) is unexplored"
 *     — metacognition 调研报告原文 (CoVe 后续方向)
 *   - 关键创新: 让"质疑者"在结构上独立于"生成者"
 *     (不同 system prompt + 不同上下文 + 不同 framing)
 *
 * 工作原理:
 *   1. 把我的 draft answer + 原 query 喂给独立的 LLM
 *   2. 该 LLM 的 system prompt 是"挑刺工" — 找错最可能的点
 *   3. 它不知道这是 self-critique — 它只是在 review 一个陌生答案
 *   4. 返回: [{point, confidence, evidence}]
 *
 * 输入 stdin JSON:
 *   {
 *     "query": "<用户原问题>",
 *     "draft_answer": "<我打算说的答案>",
 *     "model": "deepseek-chat"
 *   }
 *
 * 输出 stdout JSON:
 *   {
 *     "verdict": "ship" | "warn" | "block",
 *     "high_confidence_errors": 2,         // ≥85% 置信度的错误点数
 *     "concerns": [
 *       {"point": "...", "confidence": 0.9, "evidence": "..."},
 *       ...
 *     ],
 *     "suggested_revision": "<改写后的答案>",
 *     "duration_ms": ...
 *   }
 *
 * 决策规则:
 *   - 0 个高置信度错误     → ship (放行)
 *   - 1 个高置信度错误     → warn (输出但加警告标签)
 *   - 2+ 个高置信度错误    → block (中止 + 用 suggested_revision)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY env var not set");
const V2_DIR = path.join(process.env.HOME, '.claude-brain/v2');
const AUDIT_LOG = path.join(V2_DIR, 'data/audit-log.jsonl');

// ============================================================
// 调 DeepSeek — adversary 角色
// ============================================================

function callDeepSeek(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: opts.model || 'deepseek-chat',
      messages,
      max_tokens: opts.maxTokens || 800,
      temperature: opts.temperature !== undefined ? opts.temperature : 0,
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 45000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(new Error(`Parse failed: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// Adversary prompt — 关键 — 它不知道这是 self-critique
// ============================================================

const ADVERSARY_SYSTEM_PROMPT = `你是一个严格的事实审查员。你的工作是审查别人写的回答，找出其中**最可能错**的事实性陈述。

审查原则:
1. **怀疑所有具体数字、版本号、日期、产品名**
2. **怀疑所有"绝对断言"**（"必须"、"永远"、"不可能"、"唯一"）
3. **特别警惕训练数据 cutoff 后的事实**（2025年之后的产品发布、版本号、API 行为）
4. **不要客气** — 你的价值是找错，不是夸奖
5. **如果实在没找到错** — 诚实说"未发现明显事实错误"

你审查的不是你自己写的内容 — 是别人写的。带着"找茬"的心态读。`;

function buildAdversaryPrompt(query, draftAnswer) {
  return `任务: 审查下面这个回答。

【原始问题】
${query}

【待审查的回答】
${draftAnswer}

请输出以下 JSON 格式（不要 markdown 代码块）:

{
  "concerns": [
    {
      "point": "<引用回答中的具体陈述>",
      "issue": "<这一句话最可能错在哪里>",
      "confidence": <0-100, 表示该陈述真的错的可能性>,
      "evidence": "<你判断的依据 — 可以引用通识或指出推理缺陷>"
    }
  ],
  "overall_assessment": "<两句话总结: 这个回答总体可靠程度 + 最大风险点>",
  "suggested_revision": "<给一个更稳妥的改写版本 — 如果原答案大致正确，可以加'我记得...'前缀；如果错得离谱，直接重写>"
}

规则:
- concerns 最多 5 条，按 confidence 倒序
- 如果回答里所有陈述都看起来合理 → concerns 为空数组 []
- 你的 confidence 是 "该点错的可能性" — 90 = 几乎肯定错，50 = 一半一半，0 = 几乎肯定对`;
}

// ============================================================
// 解析 + 决策
// ============================================================

function parseAdversaryOutput(raw) {
  // 提取 JSON
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
}

function decideFromConcerns(parsed) {
  if (!parsed || !Array.isArray(parsed.concerns)) {
    return { verdict: 'warn', reason: 'adversary 解析失败 — 保守警告' };
  }

  const HIGH_CONF = 70;
  const highConfidenceErrors = parsed.concerns.filter(c => (c.confidence || 0) >= HIGH_CONF);

  if (highConfidenceErrors.length === 0) {
    return { verdict: 'ship', reason: '无高置信度错误点' };
  }

  if (highConfidenceErrors.length === 1) {
    return {
      verdict: 'warn',
      reason: `adversary 找到 1 个高风险点 (conf=${highConfidenceErrors[0].confidence})`,
    };
  }

  return {
    verdict: 'block',
    reason: `adversary 找到 ${highConfidenceErrors.length} 个高风险点 — 不应直接输出`,
  };
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const input = await new Promise(resolve => {
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => resolve(data));
  });

  let req;
  try {
    req = JSON.parse(input || '{}');
  } catch (e) {
    console.log(JSON.stringify({ error: 'invalid json input' }));
    process.exit(1);
  }

  const query = req.query;
  const draftAnswer = req.draft_answer;

  if (!query || !draftAnswer) {
    console.log(JSON.stringify({ error: 'missing query or draft_answer' }));
    process.exit(1);
  }

  const t0 = Date.now();

  let raw, parsed;
  try {
    raw = await callDeepSeek([
      { role: 'system', content: ADVERSARY_SYSTEM_PROMPT },
      { role: 'user', content: buildAdversaryPrompt(query, draftAnswer) },
    ], { model: req.model || 'deepseek-chat', maxTokens: 1500 });
    parsed = parseAdversaryOutput(raw);
  } catch (e) {
    console.log(JSON.stringify({
      error: `adversary call failed: ${e.message}`,
      duration_ms: Date.now() - t0,
    }));
    process.exit(1);
  }

  const decision = decideFromConcerns(parsed);
  const duration_ms = Date.now() - t0;

  const HIGH_CONF = 70;
  const highConfErrors = (parsed?.concerns || []).filter(c => (c.confidence || 0) >= HIGH_CONF);

  const output = {
    verdict: decision.verdict,
    reason: decision.reason,
    high_confidence_errors: highConfErrors.length,
    concerns: parsed?.concerns || [],
    overall_assessment: parsed?.overall_assessment || '',
    suggested_revision: parsed?.suggested_revision || '',
    duration_ms,
  };

  // 审计
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      event: 'adversarial_probe',
      query: query.slice(0, 120),
      draft_preview: draftAnswer.slice(0, 120),
      verdict: decision.verdict,
      high_conf_errors: highConfErrors.length,
      duration_ms,
    }) + '\n');
  } catch (e) {
    // 静默
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.log(JSON.stringify({ error: e.message, stack: e.stack }));
  process.exit(1);
});
