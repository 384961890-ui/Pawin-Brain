#!/usr/bin/env node
/**
 * inject-context.js — claude-brain v2.0 上下文注入器
 *
 * Hook: UserPromptSubmit
 *
 * 输入: stdin JSON { prompt, session_id, ... }
 * 输出: stdout JSON { decision: "approve", additionalContext: "<brain-context>..." }
 *
 * 失败策略: 静默退出（不输出/输出空），绝不阻塞主流程
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  BRAIN_DIR, loadConfig, readFileSafe, writeFileAtomic, loadLessons, markLessonsActivated, qmdSearch, grepFloor, debugLog
} = require('./util.js');

// 宿主必须由适配层显式声明。安装了 ZCode 不等于当前进程跑在 ZCode。
const HOST = process.env.CLAUDE_BRAIN_HOST || 'claude-code';
const IS_ZCODE = HOST === 'zcode';
const IS_CODEX = HOST === 'codex';
const RUNTIME_DIR = process.env.CLAUDE_BRAIN_RUNTIME_DIR || BRAIN_DIR;

const config = loadConfig();

// 一跳 [[链接]] 展开（2026-07-22 接入）：召回条目命中的文件里引用的 [[slug]] 顺手带出摘要
let expandLinks = (recall) => recall;
try { ({ expandLinks } = require('./link-expand.js')); } catch (e) { debugLog(config, 'link-expand module not loaded:', e.message); }

// ── v4 idea-loop 触发器（2026-06-09 接入）──────────────────────────────
let buildIdeaLoopBlock = () => '';
try {
  ({ buildIdeaLoopBlock } = require(path.join(RUNTIME_DIR, 'v4', 'scripts', 'idea-loop-trigger.js')));
} catch (e) {
  debugLog(config, 'v4 idea-loop module not loaded:', e.message);
}
const V4_LAST_TRIGGER_PATH = path.join(BRAIN_DIR, 'v4', 'last-trigger.json');

// ============================================================
// v3 think-loop — 卡住举旗（读 stuck-flag）+ 动手前三问
// ============================================================

const V3_FLAG_PATH = path.join(BRAIN_DIR, 'v3', 'stuck-flag.json');

// 读到 think-detect 举的旗 → 注入突破清单（消费即降旗）
function buildStuckBlock() {
  try {
    if (!fs.existsSync(V3_FLAG_PATH)) return '';
    let flag;
    try { flag = JSON.parse(fs.readFileSync(V3_FLAG_PATH, 'utf-8')); }
    catch { flag = null; }
    try { fs.unlinkSync(V3_FLAG_PATH); } catch {}   // 读一次就清，避免反复注入
    if (!flag || !flag.stuck) return '';
    return [
      '---',
      '## 🛑 THINK-LOOP：你上一轮好像在原地打转',
      '',
      '停。别在同一个点上继续用力——**卡住的是手 不是你**。',
      '过一遍突破清单，至少认真想两条不同方向：',
      '- **回溯** 是不是前面某步（a/b）就错了 根可能不在当前这步',
      '- **跳跃** 能不能跳过这步 直接奔结果',
      '- **反推** 从结果(d)倒着看 这步还是障碍吗',
      '- **解构** 把这步拆成 c1+c2+c3 也许只有一小块真难',
      '- **质疑目标** d 真是用户要的吗 别在歪掉的目标上硬磕',
      '- **换工具** 换 prompt / model / 子agent / skill 手不趁手就换手',
      '',
      '想完再动。若比对过确实只能硬解 就说清"我比过这几条路 还是这条最优"。',
      '',
    ].join('\n');
  } catch { return ''; }
}

// 工程 / 多步任务 → 注入动手前三问（反惰性规划）
const ENGINEERING_HINT = /实现|重构|修复|修一下|写个|搭一个|搭个|部署|迁移|批量|集成|优化|做一个|开发|build|refactor|implement|脚本|加个?功能|hook|流程|架构|方案/i;

function buildPlanningBlock(userPrompt, isZCode = false) {
  try {
    if (!userPrompt || !ENGINEERING_HINT.test(userPrompt)) return '';
    if (isZCode) {
      // ZCode 轻量化：只给最核心两条，不要太死板
      return [
        '---',
        '## 🧭 THINK-LOOP（轻量）',
        '',
        '动之前过一遍：',
        '- 几种解法？别抓起第一条就跑',
        '- 有没有现成轮子？先搜搜看',
        '',
      ].join('\n');
    }
    return [
      '---',
      '## 🧭 THINK-LOOP：动手前 30 秒（多步 / 工程任务）',
      '',
      '别抓起第一个方案就跑。先问自己：',
      '- **几种解法？** 至少列两条再选',
      '- **最省力哪条？** 惰性是美德 别硬走',
      '- **有现成轮子吗？** 先搜 skill / GitHub / 记忆 再决定造不造',
      '- **退路是什么？** 最坏怎么收场',
      '',
    ].join('\n');
  } catch { return ''; }
}

// ============================================================
// 时间感知 — 让 agent 知道距上次对话过了多久 + 当前是什么时段
// ============================================================

const LAST_ACTIVITY_PATH = path.join(BRAIN_DIR, 'last_activity.json');

function formatDelta(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  const rmin = min % 60;
  if (hr < 24) return `${hr}h ${rmin}m`;
  const days = Math.floor(hr / 24);
  const rhr = hr % 24;
  return `${days}天 ${rhr}h`;
}

function inferGap(ms) {
  const min = ms / 1000 / 60;
  if (min < 5) return '延续对话';
  if (min < 60) return '短暂中断';
  if (min < 180) return '工作切换 / 餐间';
  if (min < 480) return '小睡 / 外出';
  if (min < 960) return '跨越睡眠 — 用户应该刚醒';
  return '长时间未联系';
}

function inferTimeOfDay(date) {
  const h = date.getHours();
  if (h < 5) return '深夜/凌晨';
  if (h < 9) return '清晨（刚起床）';
  if (h < 12) return '上午（工作时段）';
  if (h < 14) return '午饭时段';
  if (h < 18) return '下午（工作时段）';
  if (h < 21) return '晚饭/晚间';
  return '深夜（准备睡 or 在熬）';
}

function buildTimeAwareness() {
  const now = new Date();
  const lastRecord = (() => {
    try { return JSON.parse(fs.readFileSync(LAST_ACTIVITY_PATH, 'utf-8')); }
    catch { return null; }
  })();

  const lastTime = lastRecord ? new Date(lastRecord.timestamp) : null;
  const deltaMs = lastTime ? (now - lastTime) : null;

  const pad = n => String(n).padStart(2, '0');
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${days[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // 更新 last_activity
  try {
    writeFileAtomic(LAST_ACTIVITY_PATH, JSON.stringify({
      timestamp: now.toISOString(),
      readable: nowStr,
    }, null, 2));
  } catch {}

  const lines = [];
  lines.push(`现在: ${nowStr}`);
  lines.push(`时段: ${inferTimeOfDay(now)}`);
  if (deltaMs !== null) {
    lines.push(`距上次对话: ${formatDelta(deltaMs)} — ${inferGap(deltaMs)}`);
  } else {
    lines.push(`距上次对话: 首次对话（或时间记录被清空）`);
  }
  return lines.join('\n');
}

// ============================================================
// 日记自动注入 — 今天 + 昨天片段（兑现 CLAUDE.md 承诺，6/9 v4 补齐）
// ============================================================

function buildDiaryBlock(intent) {
  try {
    // 闲聊不注入（避免无谓 token 开销）
    if (intent && intent.name === 'casual_short') return '';

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const diaryDir = path.join(os.homedir(), '.claude/diary');

    function readSnippet(date, lines) {
      try {
        const p = path.join(diaryDir, `${fmt(date)}.md`);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, 'utf-8').split('\n').slice(0, lines).join('\n');
      } catch { return null; }
    }

    const todaySnippet = readSnippet(now, 40);
    const yesterdaySnippet = readSnippet(yesterday, 20);

    if (!todaySnippet && !yesterdaySnippet) return '';

    const parts = ['---', '## 📅 DIARY（最近日记片段 — 接续昨天+今天）', ''];
    if (todaySnippet) {
      parts.push(`### 今日 ${fmt(now)}（头 40 行）`);
      parts.push(todaySnippet);
      parts.push('');
    }
    if (yesterdaySnippet) {
      parts.push(`### 昨日 ${fmt(yesterday)}（头 20 行）`);
      parts.push(yesterdaySnippet);
      parts.push('');
    }
    parts.push('> 完整日记在 `~/.claude/diary/` — 需要细节时主动读');
    parts.push('');
    return parts.join('\n');
  } catch { return ''; }
}

// ============================================================
// 意图硬路由 — 决定本次注入的"重量"
// ============================================================

// 顺序很重要 — 上面的优先匹配
// v3 路由调整（2026-06-08）：historical_deep 优先级提到 entity_specific 之前
//   场景："acme-corp 之前那次说什么" 既含实体又含历史信号 — 应走 L3 精排（reranker），
//   不能被 entity_specific 截胡走 L2 fast。
//   解决：把 historical_deep 上提；entity_specific 留作"光提实体没历史信号"的兜底（如"acme-corp 现在怎么样了"）。
const INTENT_RULES = [
  {
    name: 'explicit_file',
    patterns: [/(?:读|打开|cat|看[一下]?|瞧瞧|show me).{0,20}\.(md|json|js|py|ts|txt|sh|html|css)/i],
    config: { skip_qmd: true, lessons_count: 0, reason: '明确指定文件 — 直接 Read 更准' }
  },
  {
    name: 'historical_deep',
    patterns: [/(?:之前|上次|上回|历史|曾经|过去|那次|那时候)/, /(?:我做过|我说过|你说过)/, /(?:去年|上个?月|上周)/],
    config: { skip_qmd: false, qmd_top_k: 5, lessons_count: 3, qmd_endpoint: '/search', reason: '查历史 — L3 reranker 精排 + 多 lessons' }
  },
  {
    name: 'entity_specific',
    // example entity list — replace with the people/projects/codenames YOUR agent
    // actually talks about; these route entity mentions to a deeper recall tier
    patterns: [
      /(?:acme-corp|project-nimbus|claude-brain|brain v1\.)/i,
    ],
    config: { skip_qmd: false, qmd_top_k: 5, lessons_count: 2, reason: '提到实体（无历史信号）— L2 fast + path-boost' }
  },
  {
    name: 'temporal_now',
    patterns: [/^(?:现在|当下|此刻|今天|刚才|刚刚)/, /(?:你)?在吗/, /^\.$/],
    config: { skip_qmd: true, lessons_count: 1, reason: '问当下 — STATE.md 已注入足够' }
  },
  {
    name: 'tool_skill_query',
    patterns: [/(?:怎么|如何|用什么|用哪个|哪个工具|什么命令)/, /(?:技能|skill|工具|tool)(?:有|用|找)/i],
    config: { skip_qmd: true, lessons_count: 1, inject_tools_index: true, reason: '问工具技能 — 注入 tools/INDEX.md' }
  },
  {
    name: 'casual_short',
    patterns: [/^(?:喜欢|想你|无聊|困|累|哈+|嗯|哦|好的|睡了?|晚安|起床|醒|在吗|早)[\s~～！!?？.。]*$/],
    config: { skip_qmd: true, lessons_count: 0, reason: '闲聊 — 不需要技术上下文' }
  },
];

function detectIntent(prompt) {
  if (!prompt) return { name: 'default', skip_qmd: false, lessons_count: 3, qmd_top_k: 3, reason: '空 prompt' };
  for (const rule of INTENT_RULES) {
    for (const p of rule.patterns) {
      if (p.test(prompt)) {
        const intent = { name: rule.name, ...rule.config };
        // ZCode 轻量化：默认 lessons 减到 1 条，skip_qmd 更激进
        if (IS_ZCODE) {
          if (intent.lessons_count === undefined || intent.lessons_count > 1) {
            intent.lessons_count = 1;
          }
          // ZCode 下只有明确查历史/实体才用 QMD，其他情况 skip
          if (!['historical_deep', 'entity_specific'].includes(intent.name)) {
            intent.skip_qmd = true;
          }
        }
        return intent;
      }
    }
  }
  const defaultIntent = { name: 'default', skip_qmd: IS_ZCODE, lessons_count: IS_ZCODE ? 1 : 3, qmd_top_k: 3, reason: '默认 — 全量注入' };
  return defaultIntent;
}

let stdinData = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => stdinData += c);
process.stdin.on('end', () => {
  // qmdSearch 改走 Node http 模块后是异步的（2026-07-22），buildContext 里 await 它，
  // 所以这里也要等 — 包一层 async IIFE，出口逻辑（写一次 stdout 再 exit）不变。
  (async () => {
    try {
      const input = stdinData.trim() ? JSON.parse(stdinData) : {};
      const userPrompt = (input.prompt || input.user_prompt || '').toString();
      const context = await buildContext(userPrompt, input);
      // Claude Code UserPromptSubmit hook 接受 JSON 输出
      process.stdout.write(JSON.stringify({
        decision: 'approve',
        additionalContext: context
      }));
    } catch (e) {
      debugLog(config, 'inject-context error:', e.message);
      // 静默成功 — 不阻塞用户
      process.stdout.write('');
    }
    process.exit(0);
  })();
});

async function buildContext(userPrompt, input = {}) {
  // 1. 检测 intent — 决定本次注入的"重量"
  const intent = detectIntent(userPrompt);
  debugLog(config, `intent: ${intent.name} (${intent.reason}) ${IS_ZCODE ? '[ZCode 轻量化]' : ''}`);

  // Claude Code 的身份正本由 CLAUDE.md 注入，不重复占 context。
  // Codex 插件没有这条宿主级自动注入，因此显式带入用户自己的 IDENTITY.md。
  const identity = IS_CODEX ? readFileSafe(path.join(BRAIN_DIR, 'IDENTITY.md')) : '';
  const state = readFileSafe(path.join(BRAIN_DIR, 'STATE.md'));

  // 2. lessons — 数量按 intent 控制
  const lessonsCount = intent.lessons_count !== undefined
    ? intent.lessons_count
    : (config.max_lessons_inject || 3);
  const LESSONS_INDEX = path.join(BRAIN_DIR, 'lessons/INDEX.json');
  const lessons = loadLessons(LESSONS_INDEX).slice(0, lessonsCount);

  // v7.1 P2 (2026-06-25): session 级激活去重
  //   之前每条 user prompt 都 mark → 三天 100 prompt × top3 = top3 lesson 各 300 次
  //   真相是"被注入了 N 次"不是"被用到了 N 次"。改成 session 内每条 lesson 只算一次
  //   state/activated-<sid>.json 记本 session 已激活过的 id 集合
  if (lessons.length > 0) {
    try {
      // c4 (2026-07-22): session_id 来自宿主传入的 stdin JSON，宿主半可信但不是零信任 —
      // 不消毒直接拼路径，含 '/' 或 '..' 的 sid 能穿出 state/ 目录。白名单只留 [A-Za-z0-9_-]。
      const sid = (input.session_id || 'unknown').toString().replace(/[^\w-]/g, '_');
      const seenPath = path.join(BRAIN_DIR, 'state', `activated-${sid}.json`);
      let seen = new Set();
      try { seen = new Set(JSON.parse(fs.readFileSync(seenPath, 'utf-8'))); } catch {}
      const fresh = lessons.map(l => l.id).filter(id => !seen.has(id));
      if (fresh.length > 0) {
        markLessonsActivated(LESSONS_INDEX, fresh);
        fresh.forEach(id => seen.add(id));
        try { writeFileAtomic(seenPath, JSON.stringify([...seen])); } catch {}
      }
    } catch (e) {
      debugLog(config, 'markLessonsActivated error:', e.message);
    }
  }

  // 3. 召回 — 按 intent 决定是否调，并选择层级
  //    default intent（六条正则都没命中的兜底）先试 grep 免费地板（7/20 加入）：
  //    整句字面量命中 MEMORY.md / lessons/INDEX.json 就用，省一次 embedding；不命中原样落回 QMD。
  //    其余 intent 不碰 grep，行为跟改动前一致：默认走 L2 /search_fast (warm ~1.5s)，
  //    historical_deep 走 L3 /search (reranker 精排)。
  let recall = [];
  let recallSource = 'qmd';
  if (!intent.skip_qmd && userPrompt.length >= 6 && config.qmd_enabled) {
    let floorHit = false;
    if (intent.name === 'default') {
      const floor = grepFloor(userPrompt, config);
      if (floor.hit) {
        recall = floor.snippets;
        recallSource = 'grep-floor';
        floorHit = true;
      }
    }
    if (!floorHit) {
      const localConfig = { ...config };
      if (intent.qmd_top_k) localConfig.qmd_top_k = intent.qmd_top_k;
      recall = await qmdSearch(userPrompt, localConfig, intent.qmd_endpoint);
    }
  }
  debugLog(config, `recall: source=${recallSource} count=${recall.length}`);
  // 一跳链接展开：给召回条目附加它命中文件里引用的 [[slug]] 摘要（config.link_expansion_enabled 默认 true）
  try { recall = expandLinks(recall, config); } catch (e) { debugLog(config, 'expandLinks error:', e.message); }

  // 4. tools/INDEX.md — 仅在 tool_skill_query intent 时注入
  let toolsIndex = '';
  if (intent.inject_tools_index) {
    toolsIndex = readFileSafe(path.join(BRAIN_DIR, 'tools/INDEX.md'));
  }

  // 时间感知 — 必须每次注入（让我察觉时间流逝）
  const timeBlock = buildTimeAwareness();

  const parts = [];
  parts.push('<brain-context>');
  if (identity) {
    parts.push('## 🧠 IDENTITY');
    parts.push('');
    parts.push(identity.trim());
    parts.push('');
  }
  parts.push(`> 🧠 claude-brain v2.0 · intent=\`${intent.name}\` · ${intent.reason} ${IS_ZCODE ? '[ZCode 轻量化]' : ''}`);
  parts.push('');

  // v3 think-loop：卡住举旗优先注入（紧急救援，最高优先级）
  const stuckBlock = buildStuckBlock();
  if (stuckBlock) parts.push(stuckBlock);

  // ZCode 轻量化：idea-loop 和工程规划块只在真正需要时才注入
  if (!IS_ZCODE) {
    // v4 idea-loop：项目迭代场景触发器（战略层 — 2026-06-09 接入）
    const ideaLoopBlock = buildIdeaLoopBlock(userPrompt, input.cwd, V4_LAST_TRIGGER_PATH);
    if (ideaLoopBlock) parts.push(ideaLoopBlock);
  }

  // v3 think-loop：工程任务动手前三问（战术层）—— ZCode 下强度降级
  const planningBlock = buildPlanningBlock(userPrompt, IS_ZCODE);
  if (planningBlock) parts.push(planningBlock);

  parts.push('---');
  parts.push('## ⏰ TIME');
  parts.push(timeBlock);
  parts.push('');

  // 宿主标识 - 写日记/报告时盖的章（双宿主区分）
  parts.push(`> 📍 当前宿主：${IS_ZCODE ? 'ZCode' : 'CC'} · 写日志/报告时标注宿主`);
  parts.push('');

  // IDENTITY 身份复述已下线（2026-06-16 去重）— CLAUDE.md 灵魂段为唯一正本；
  // brain 独占内容（碳基/硅基框架·盾牌比喻·人机开关）已先迁入 CLAUDE.md「我怎么想」。
  // c2 (2026-07-22): 之前这里留了个 `if (false && identity)` 死代码块（连带一次白读
  // IDENTITY.md）当"一键恢复开关"——发布件里不该带永远走不到的分支，真要恢复从 git 历史翻。

  // 7/20: 心境时效折叠 — 超 7 天的心境段不再全文注入（陈货心境比没有更糟：每天醒来被塞一个月前的心情）
  const foldStaleMood = (text) => text.replace(
    /## 当前心境（([^）]*)）[\s\S]*?(?=\n## |\n---|$)/g,
    (block, dateStr) => {
      const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
      const days = m ? Math.floor((Date.now() - new Date(m[0]).getTime()) / 86400000) : Infinity;
      if (days <= 7) return block;
      const label = m ? `最后写于 ${m[0]} 已停更 ${days} 天` : `标题无完整日期（${dateStr}）视为过期`;
      return `## 当前心境\n\n（${label} — 当下心境以近几日日记为准 该更新 STATE 了）\n`;
    }
  );
  const state2 = state ? foldStaleMood(state) : state;

  if (state2) {
    parts.push('---');
    parts.push('## 📍 STATE');
    parts.push('');
    // ZCode 轻量化：只注入 STATE.md 的前半部分（心境 + 最近项目 + 调度链路），砍掉历史冗余
    if (IS_ZCODE) {
      const stateLines = state2.trim().split('\n');
      // c3 (2026-07-22): 原代码外层 includes('待办')/includes('注意事项')/includes('##')
      // 是死条件——内层已经要求 startsWith('##')，满足内层必然满足外层，外层从没单独生效过；
      // 且原逻辑在第一个 `##`（i>5）就砍，跟注释"第二个 ## 之后开始砍掉"对不上（少保留了一节）。
      // 改成真数到第二个顶级标题再砍，代码与注释意图一致。
      let cutIdx = stateLines.length;
      let headerCount = 0;
      for (let i = 0; i < stateLines.length; i++) {
        if (stateLines[i].startsWith('##') && i > 5) {
          headerCount++;
          if (headerCount === 2) {
            cutIdx = i;
            break;
          }
        }
      }
      parts.push(stateLines.slice(0, cutIdx).join('\n'));
    } else {
      parts.push(state2.trim());
    }
    parts.push('');
  }

  if (lessons.length > 0) {
    parts.push('---');
    parts.push(`## 🩹 LESSONS · ${lessons.length}`);
    parts.push('');
    for (const l of lessons) {
      parts.push(`### ${l.title} \`${l.severity}\``);
      parts.push(l.summary);
      parts.push('');
    }
  }

  // ZCode 轻量 skill 提醒 — 工程任务时加一行，不强制
  if (IS_ZCODE && ENGINEERING_HINT.test(userPrompt || '')) {
    parts.push('---');
    parts.push('💡 提醒：这个任务可能有对应 skill，需要的话我可以先搜一下。');
    parts.push('');
  }

  // 日记自动注入（CLAUDE.md 承诺 — 6/9 v4 补齐）—— ZCode 下默认关闭
  if (!IS_ZCODE) {
    const diaryBlock = buildDiaryBlock(intent);
    if (diaryBlock) parts.push(diaryBlock);
  }

  if (toolsIndex) {
    parts.push('---');
    parts.push('## 🛠️ TOOLS INDEX');
    parts.push('');
    parts.push(toolsIndex.trim());
    parts.push('');
  }

  if (recall.length > 0) {
    parts.push('---');
    parts.push(recallSource === 'grep-floor'
      ? `## 🔍 GREP-FLOOR · ${recall.length}（本地字面匹配，未过 embedding）`
      : `## 💭 QMD · ${recall.length}`);
    parts.push('');
    const maxChars = config.max_recall_chars || 200;
    for (const r of recall) {
      const content = (r.content || r.text || r.chunk || '').toString().slice(0, maxChars);
      const file = r.file || r.source || '';
      if (content) {
        parts.push(`- **${file}**: ${content}...`);
        if (r.linkBlock) parts.push(r.linkBlock);
      }
    }
    parts.push('');
  } else if (recall.failed) {
    // 7/20: 查询失败显式化 — 别让我把"没查成"当成"没有这段记忆"
    parts.push('---');
    parts.push(`## 💭 QMD · ⚠️ ${recall.failed} — 这不代表没有相关记忆 需要时手动重查 /search_fast`);
    parts.push('');
  }

  parts.push('</brain-context>');
  return parts.join('\n');
}
