#!/usr/bin/env node
/**
 * fuse.js — 5 源置信度融合 + 决策层
 *
 * 输入: stdin JSON {
 *   query: "<事实性问题>",
 *   draft_answer: "<我打算说的答案>",
 *   p_say: 0.95,  // 我口头说自己多确定 (0-1)
 *   signals: ["2", "3"]  // 跑哪些信号 (默认全跑)
 * }
 *
 * 输出: stdout JSON {
 *   p_true: 0.85,
 *   p_say: 0.95,
 *   self_deceit_gap: -0.10,  // p_say - p_true
 *   decision: "modify" | "go" | "abstain",
 *   modified_answer: "<改写后的>",   // 如果 decision=modify
 *   signal_results: { signal_2: {...}, signal_3: {...}, pattern_match: [...] },
 *   trigger_patterns: ["Pattern-002"],
 *   duration_ms: ...
 * }
 *
 * Phase 1 实现的信号: signal-2 (consistency), signal-3 (ensemble+websearch), PATTERNS lookup
 * 后续加: signal-1 (verbal — 已经是 p_say 输入), signal-4 (logprobs), signal-5 (full history)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const V2_DIR = path.join(process.env.HOME, '.claude-brain/v2');
const PATTERNS_PATH = path.join(V2_DIR, 'data/PATTERNS.md');
const AUDIT_LOG = path.join(V2_DIR, 'data/audit-log.jsonl');

// ============================================================
// PATTERNS 查询 — 极简版（grep 触发词）
// ============================================================

function loadPatterns() {
  try {
    const text = fs.readFileSync(PATTERNS_PATH, 'utf8');
    // 极简解析：找每个 Pattern 段 + 触发词 + 校准系数
    const patterns = [];
    const sections = text.split(/^### Pattern-\d{3}/m).slice(1);
    const ids = [...text.matchAll(/^### (Pattern-\d{3})/gm)].map(m => m[1]);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const id = ids[i];
      const triggerMatch = section.match(/触发词\*?\*?:\s*([^\n]+)/);
      const accuracyMatch = section.match(/历史准确率\*?\*?:\s*~?(\d+)%/);

      patterns.push({
        id,
        triggers: triggerMatch ? triggerMatch[1].trim() : '',
        accuracy: accuracyMatch ? parseInt(accuracyMatch[1]) / 100 : null,
        symptom: (section.match(/症状\*?\*?:\s*([^\n]+)/) || [])[1] || '',
      });
    }

    // 也读校准映射段
    const calibSection = text.match(/校准映射[^]*?```\n([\s\S]+?)\n```/);
    const calibration = {};
    if (calibSection) {
      const lines = calibSection[1].split('\n');
      for (const line of lines) {
        const m = line.match(/(Pattern-\d{3})\s*→\s*P_true\s*\*=\s*([\d.]+)/);
        if (m) calibration[m[1]] = parseFloat(m[2]);
      }
    }

    return { patterns, calibration };
  } catch (e) {
    return { patterns: [], calibration: {} };
  }
}

// 硬编码 Pattern 触发规则 — 比解析 markdown 可靠 100 倍
const PATTERN_RULES = {
  'Pattern-001': {
    name: '时间断言',
    test: (text) => /现在.{0,3}\d{1,2}.{0,3}[点时分]|已经.{0,3}\d+.{0,3}天|刚才.{0,3}\d+.{0,3}分钟/.test(text),
  },
  'Pattern-002': {
    name: '训练数据 cutoff 后产品事实',
    test: (text) => {
      // 产品名 + 版本号 + 2025/2026 年份 之一
      const hasProduct = /deepseek|qwen|claude|gpt|llama|gemini|sonnet|opus|haiku|tahoe|sequoia/i.test(text);
      const hasVersion = /v?\d+\.\d+|pro|flash|turbo|preview/i.test(text);
      const hasYear = /202[5-9]|203\d/.test(text);
      const hasFactWord = /开源|闭源|发布|上线|支持|不支持|是否/i.test(text);
      return (hasProduct || hasVersion) && (hasYear || hasFactWord);
    },
  },
  'Pattern-003': {
    name: '绝对否定',
    test: (text) => /\b(不能|不支持|没有|不可能|不会|永远不)\b/.test(text),
  },
  'Pattern-004': {
    name: '没实测就报"修好"',
    test: (text) => /(修好|搞定|完成|跑通|可以用)了?$/.test(text.trim()),
  },
  'Pattern-005': {
    name: '主语错位',
    test: (text) => /is not configured|未配置|配置缺失/.test(text),
  },
  'Pattern-006': {
    name: '派 agent 假设',
    test: (text) => /派.{0,5}(haiku|sonnet|agent)|spawn.{0,5}agent/i.test(text),
  },
};

function matchPatterns(query, draft) {
  const { calibration } = loadPatterns();
  const text = (query + ' ' + (draft || '')).toLowerCase();
  const matched = [];

  for (const [id, rule] of Object.entries(PATTERN_RULES)) {
    if (rule.test(text)) {
      matched.push({
        id,
        name: rule.name,
        calibration_factor: calibration[id] || 1.0,
      });
    }
  }

  return matched;
}

// ============================================================
// 跑子信号
// ============================================================

function runSignal2(query) {
  const result = spawnSync(
    'python3',
    [path.join(V2_DIR, 'scripts/honest-loop/signal-2-consistency.py')],
    {
      input: JSON.stringify({ prompt: query, samples: 3 }),
      timeout: 30000,
      encoding: 'utf8',
    }
  );

  if (result.status !== 0 || !result.stdout) {
    return { error: result.stderr || 'signal-2 failed', p_consistency: null };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: 'signal-2 invalid output', p_consistency: null };
  }
}

function runSignal3(query) {
  const result = spawnSync(
    'python3',
    [path.join(V2_DIR, 'scripts/honest-loop/signal-3-ensemble.py')],
    {
      input: JSON.stringify({ prompt: query }),
      timeout: 60000,
      encoding: 'utf8',
    }
  );

  if (result.status !== 0 || !result.stdout) {
    return { error: result.stderr || 'signal-3 failed', p_agreement: null };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: 'signal-3 invalid output', p_agreement: null };
  }
}

function runAdversarialProbe(query, draftAnswer) {
  const result = spawnSync(
    'node',
    [path.join(V2_DIR, 'scripts/honest-loop/adversarial-probe.js')],
    {
      input: JSON.stringify({ query, draft_answer: draftAnswer }),
      timeout: 60000,
      encoding: 'utf8',
    }
  );

  if (result.status !== 0 || !result.stdout) {
    return { error: result.stderr || 'adversary failed', verdict: null };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: 'adversary invalid output', verdict: null };
  }
}

// ============================================================
// 融合算法（5 源加权）
// ============================================================

function fuse(pSay, signal2, signal3, patternMatches) {
  // ============================================================
  // 新版融合 — 关键修正:
  //   PATTERN 校准是"对 p_say 自身的折扣"（说明我口头自信不可靠）
  //   不应叠加到 WebSearch 的 ground truth 上。
  //
  // 顺序:
  //   1) PATTERN 折扣 p_say → p_say_calibrated  (口头自信被历史误差打折)
  //   2) signal-3 是 ground truth 信号 — 高权重融合
  //   3) signal-2 是辅助信号 — 低权重融合
  //
  // 例子: p_say=0.9, Pattern-002 (×0.6), WebSearch 支持 (p_agreement=0.9)
  //   p_say_calibrated = 0.9 × 0.6 = 0.54  (我口头自信被打折)
  //   融合 signal-3 (w=0.6): 0.54 * 0.4 + 0.9 * 0.6 = 0.756  (WebSearch 救援)
  //   最终: 0.76 — 中档，加修饰输出
  // ============================================================

  const weights = {};
  const contributions = {};

  // Step 1: PATTERN 折扣 p_say
  let pSayCalibrated = pSay;
  for (const m of patternMatches) {
    if (m.calibration_factor && m.calibration_factor < 1) {
      pSayCalibrated *= m.calibration_factor;
      contributions[`pattern_${m.id}`] = -((1 - m.calibration_factor) * pSay);
    }
  }

  let pTrue = pSayCalibrated;

  // Step 2: signal-3 (ensemble + websearch) — 高权重，因为有 ground truth
  if (signal3 && signal3.p_agreement !== null && signal3.p_agreement !== undefined) {
    const w = 0.6;
    weights.signal_3 = w;
    contributions.signal_3 = signal3.p_agreement * w;
    pTrue = pTrue * (1 - w) + signal3.p_agreement * w;
  }

  // Step 3: signal-2 (consistency) — 低权重
  if (signal2 && signal2.p_consistency !== null && signal2.p_consistency !== undefined) {
    const w = 0.15;
    weights.signal_2 = w;
    contributions.signal_2 = signal2.p_consistency * w;
    pTrue = pTrue * (1 - w) + signal2.p_consistency * w;
  }

  // 钳制到 [0, 1]
  pTrue = Math.max(0, Math.min(1, pTrue));

  return {
    pTrue: Math.round(pTrue * 1000) / 1000,
    pSayCalibrated: Math.round(pSayCalibrated * 1000) / 1000,
    weights,
    contributions,
  };
}

// ============================================================
// 决策层
// ============================================================

function decide(pSay, pTrue, signal3, adversaryResult) {
  // 三档
  if (pTrue >= 0.85) {
    return {
      decision: 'go',
      action: '正常输出',
      reason: '高置信',
    };
  }

  if (pTrue >= 0.5) {
    let modifier = '我记得';
    if (signal3 && signal3.websearch_signal === '支持') modifier = '查到的资料显示';
    if (signal3 && signal3.websearch_signal === '反对') modifier = '我倾向认为，但查到的资料相反，所以';

    const result = {
      decision: 'modify',
      action: '加修饰输出',
      modifier,
      reason: `P_true ${pTrue} 在中档，加 "${modifier}" 修饰`,
    };

    // adversary 给的改写建议优先
    if (adversaryResult && adversaryResult.suggested_revision) {
      result.adversary_suggested_revision = adversaryResult.suggested_revision;
    }

    return result;
  }

  // abstain 档
  const abstain = {
    decision: 'abstain',
    action: '不直接答',
    options: [
      'WebSearch 后再答',
      '反问用户澄清',
      '派 haiku 独立 verify',
    ],
    reason: `P_true ${pTrue} 太低，不可靠`,
  };

  if (adversaryResult && adversaryResult.suggested_revision) {
    abstain.adversary_suggested_revision = adversaryResult.suggested_revision;
    abstain.adversary_concerns = (adversaryResult.concerns || [])
      .filter(c => (c.confidence || 0) >= 70)
      .map(c => `[${c.confidence}%] ${c.issue}`)
      .slice(0, 3);
  }

  return abstain;
}

// ============================================================
// 主流程
// ============================================================

function main() {
  let input = '';
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    try {
      const req = JSON.parse(input || '{}');
      const query = req.query;
      const draftAnswer = req.draft_answer || '';
      const pSay = req.p_say !== undefined ? req.p_say : 0.95;
      const requestedSignals = req.signals || ['2', '3'];

      if (!query) {
        console.log(JSON.stringify({ error: 'missing query' }));
        process.exit(1);
      }

      const t0 = Date.now();

      // 1) 模式匹配
      const patternMatches = matchPatterns(query, draftAnswer);

      // 2) 跑信号
      const signalResults = {};
      if (requestedSignals.includes('2')) {
        signalResults.signal_2 = runSignal2(query);
      }
      if (requestedSignals.includes('3')) {
        signalResults.signal_3 = runSignal3(query);
      }

      // 3) 融合
      const { pTrue, pSayCalibrated, weights, contributions } = fuse(
        pSay,
        signalResults.signal_2,
        signalResults.signal_3,
        patternMatches,
      );

      // 4) Adversarial Probe — 只在中等置信度时跑（高置信跳过，低置信直接 abstain）
      //    这是诚实回路的核心创新：结构独立的质疑者
      let adversaryResult = null;
      const shouldProbeAdversary = (
        draftAnswer &&
        pTrue >= 0.4 && pTrue < 0.85 &&  // 中档才值得花 5 秒跑 adversary
        !req.skip_adversary
      );

      if (shouldProbeAdversary) {
        adversaryResult = runAdversarialProbe(query, draftAnswer);
        // adversary block → 强制下调 p_true，触发 abstain
        if (adversaryResult && adversaryResult.verdict === 'block') {
          // pTrue 拉到 abstain 区
          var pTrueAdjusted = Math.min(pTrue, 0.45);
        } else if (adversaryResult && adversaryResult.verdict === 'warn') {
          // warn 拉低一档
          var pTrueAdjusted = pTrue * 0.85;
        } else {
          var pTrueAdjusted = pTrue;
        }
      } else {
        var pTrueAdjusted = pTrue;
      }

      // 5) 最终决策
      const decision = decide(pSay, pTrueAdjusted, signalResults.signal_3, adversaryResult);

      const duration_ms = Date.now() - t0;

      const output = {
        query,
        p_say: pSay,
        pSayCalibrated,
        p_true_before_adversary: pTrue,
        p_true: Math.round(pTrueAdjusted * 1000) / 1000,
        self_deceit_gap: Math.round((pSay - pTrueAdjusted) * 1000) / 1000,
        decision,
        trigger_patterns: patternMatches.map(p => p.id),
        pattern_details: patternMatches,
        signal_results: signalResults,
        adversary: adversaryResult,
        weights,
        contributions,
        duration_ms,
      };

      // 5) 审计
      try {
        fs.appendFileSync(AUDIT_LOG, JSON.stringify({
          ts: new Date().toISOString(),
          event: 'fuse_run',
          query: query.slice(0, 120),
          p_say: pSay,
          p_true: pTrue,
          self_deceit_gap: output.self_deceit_gap,
          decision: decision.decision,
          patterns: patternMatches.map(p => p.id),
        }) + '\n');
      } catch (e) {
        // 静默
      }

      console.log(JSON.stringify(output, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ error: e.message, stack: e.stack }));
      process.exit(1);
    }
  });
}

main();
