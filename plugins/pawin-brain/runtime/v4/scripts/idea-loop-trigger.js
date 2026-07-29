#!/usr/bin/env node
/**
 * idea-loop-trigger.js — claude-brain v4 自动触发器
 *
 * 治三个本能：沉没成本死磕 + CEO 模式自觉飘忘 + context 堆爆
 * 详见 ~/.claude-brain/v4/DESIGN.md
 *
 * 用法：从 inject-context.js 调用
 *   const { buildIdeaLoopBlock } = require('.../v4/scripts/idea-loop-trigger.js');
 *   const block = buildIdeaLoopBlock(prompt, cwd, lastTriggerPath);
 *   if (block) parts.push(block);
 *
 * 触发条件：
 *   ① 关键词命中（必要）：含「优化/迭代/升级/重构/R1-6 批/下一步/这个项目」等
 *   ② cwd 命中（加权）：在已知项目目录内
 *   ③ 节流：同一 session/机器 5 分钟内不重复注入
 *
 * 失败策略：静默返回 ''（不阻塞主流程）
 */

const fs = require('fs');

// ── 项目迭代信号词（关键词命中是必要条件）─────────────────────────────────
const IDEA_LOOP_HINT = /优化|迭代|升级|重构|R[1-9](?:\s|批|减负|前端|后端|诚信)|下一步.*?(?:走|干|做)|怎么走|启动新.*?项目|开新.*?项目|要不要做|可以做|项目要怎么|这个项目下一步|dogfood|侦察|swarm/i;

// ── 已知项目目录（cwd 命中加权）──────────────────────────────────────────
const KNOWN_PROJECT_PATHS = [
  '<your-project-dir-1>',
  '~/.claude/workspace/projects/<your_project_1>',
  '~/.claude-brain',
  '<your-project-dir-2>',
];

// ── 节流：5 分钟冷却（避免主脑被自己写的提醒淹死）─────────────────────────
const COOLDOWN_MS = 5 * 60 * 1000;

function isThrottled(lastTriggerPath) {
  try {
    if (!fs.existsSync(lastTriggerPath)) return false;
    const data = JSON.parse(fs.readFileSync(lastTriggerPath, 'utf-8'));
    const last = new Date(data.timestamp);
    return (Date.now() - last.getTime()) < COOLDOWN_MS;
  } catch { return false; }
}

function recordTrigger(lastTriggerPath) {
  try {
    fs.writeFileSync(lastTriggerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function cwdMatchesKnownProject(cwd) {
  if (!cwd) return false;
  return KNOWN_PROJECT_PATHS.some(p => cwd.startsWith(p));
}

/**
 * 构建 v4 idea-loop 注入块
 * @param {string} prompt - 用户消息
 * @param {string|undefined} cwd - 当前工作目录（从 hook input 拿）
 * @param {string} lastTriggerPath - 节流时间戳文件路径
 * @returns {string} 注入文本，或 '' 跳过
 */
function buildIdeaLoopBlock(prompt, cwd, lastTriggerPath) {
  try {
    if (!prompt) return '';

    // 必要条件：关键词命中
    if (!IDEA_LOOP_HINT.test(prompt)) return '';

    // 节流：5 分钟内已注入过 → 跳过
    if (isThrottled(lastTriggerPath)) return '';

    // cwd 命中是加权信号（不影响触发，但影响文案）
    const cwdHit = cwdMatchesKnownProject(cwd);

    // 记录注入时间（先记后注入，防止异常时反复触发）
    recordTrigger(lastTriggerPath);

    return [
      '---',
      '## 🔁 IDEA-LOOP（v4 自动触发 · 项目迭代场景）',
      '',
      cwdHit
        ? `> 检测到 cwd 在已知项目（\`${cwd}\`）+ 迭代信号词。`
        : '> 检测到项目迭代信号词。',
      '> **别一上来就动手** —— 按 idea-loop 形态先过一遍：',
      '',
      '**1️⃣ 派 swarm 侦察（不是 opus 自己 grep）**',
      '- haiku × 1：扫腐化（零引用脚本/一次性废文件/dead code）',
      '- sonnet × 3：扫前端/后端/产品',
      '- **opus 我只汇总分 🟢🟡🔴 → 拆派/审核/commit**',
      '',
      '**2️⃣ R1 减负永远先做（防腐化）**',
      '- 删死代码 / 砍冗余配置 / 清一次性脚本',
      '- main 干净就敢删（可回滚）',
      '- 不背包袱才能后面 R2/R3/R4 跑得快',
      '',
      '**3️⃣ 模型分层（CEO 铁律 hook 化）**',
      '- 派 sonnet 改代码，opus **不碰一行**',
      '- opus 只拆派/审核/commit',
      '- **commit 后必查 `git log` 确认钉住**（沙箱回滚是真坑）',
      '',
      '**4️⃣ context 经济（idea-loop 的前提）**',
      '- agent 返回压缩（schema 强制结构化最稳）',
      '- bash 输出污染就写 `/tmp` 再 Read',
      '- 主脑只装结论 — 跑 3 轮收口换会话',
      '',
      '**5️⃣ 干不好就 pass（反沉没成本）**',
      '- 卡住别在 c 上死磕（走 v3 think-loop 突破清单）',
      '- 真不行就**果断 pass**，把 idea 推到下一轮',
      '- "干不好就 pass" 不是失败，是省下来的时间能跑下一个 idea',
      '',
      '> 详见 `~/.claude-brain/v4/DESIGN.md` · 同 session 5 分钟内不重复触发',
      '',
    ].join('\n');
  } catch { return ''; }
}

module.exports = { buildIdeaLoopBlock };
