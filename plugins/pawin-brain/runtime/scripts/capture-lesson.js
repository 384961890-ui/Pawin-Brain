#!/usr/bin/env node
/**
 * capture-lesson.js — claude-brain v2.0 教训捕获器
 *
 * Hook: Stop
 *
 * 输入: stdin JSON { session_id, transcript_path, ... }
 * 输出: 无（静默）
 *
 * 策略: 启发式扫描 transcript 末尾用户消息，检测纠正信号，写一条 draft lesson
 *       不调 LLM（保证速度+零成本+不阻塞 Stop hook）
 *       Draft 状态，需用户后续 promote 为 confirmed
 */

const fs = require('fs');
const path = require('path');
const {
  BRAIN_DIR, loadConfig, readFileSafe, writeFileAtomic, nowISO, debugLog
} = require('./util.js');
// v7 P1：行为指标计算（PostToolUse 已经把数据写好了，这里读 + 算分）
let behaviorMod = null;
try { behaviorMod = require('./track-behavior.js'); } catch {}
// v7 P2：lesson 自动降权（Stop hook 顺手跑，24h 节流）
let decayMod = null;
try { decayMod = require('./decay-lessons.js'); } catch {}
// v8：疗效归因（session 死透后把行为分挂回激活过的 lessons）
let efficacyMod = null;
try { efficacyMod = require('./efficacy.js'); } catch {}

const config = loadConfig();

// 纠正信号分四类（trigger 字段的取值来源）
// 检测顺序：false_success > abandon > explicit > implicit
// （false_success 优先级最高：谎报成功比"放弃纠正"更严重——不只是没改好，是骗了人）
const TRIGGER_PATTERNS = {
  // 放弃信号：用户已失望，停止试图纠正你
  abandon_signal: [
    /算了[，,。!！\s]|^算了\s*$/m,
    /随便(?:吧|你)/,
    /(?:不要|别)再(?:这样|犯|说|搞)/,
    /我不(?:管|想说|想问)了/
  ],
  // 明面纠正：直接指出错误
  explicit_correction: [
    /不是这样|又犯|又这样|搞错了|纠正你|纠正我|你错了|不对/,
    /(?:why|how come)(?:.{0,10})(?:always|again|keep)/i,
    /(?:降级|降智|又掉|掉进)/
  ],
  // 隐式重述：通过提醒/重复来纠正（语气更轻但同样是纠正）
  implicit_rephrase: [
    /(?:我|你)之前(?:说|告诉|提过|讲过)过?/,
    /你(?:应该|不应该)/,
    /我(?:发现|觉得|跟你说)你(?:每次|总是|又|这样)/
  ],
  // v8 D1：谎报成功 — 说完成/修好了但实际没有，比普通纠正更毒（骗人 + 没解决）
  false_success: [
    /(不是|你)?(说|刚说)(已经|都)?(搞定|完成|修好|好了|弄好)[^。]{0,15}(结果|实际|根本|怎么)(还是|没|不行|不对)/,
    /(哪里|哪儿)(好了|修好了|完成了)/,
    /(又|还)(谎报|骗我|假装)(成功|好了|完成)?/,
    /根本没(修好|完成|搞定|解决)/
  ]
};

// 兼容老代码：扁平 list 用于打分（保持原有 signalScore 逻辑不变）
const CORRECTION_PATTERNS = [
  ...TRIGGER_PATTERNS.abandon_signal,
  ...TRIGGER_PATTERNS.explicit_correction,
  ...TRIGGER_PATTERNS.implicit_rephrase,
  ...TRIGGER_PATTERNS.false_success
];

// 强正面信号 — 出现就重置分数（说明用户是在表扬不是纠正）
const STRONG_POSITIVE_PATTERNS = [
  /你做得(?:很)?好|完美|你说得对|这次(?:对了|做对了)|做得不错/,
  /(?:这版|这次|这个).+(?:比.+好|更好|不错)/,
  /^(?:好的|没错|对的|完美|搞定|可以|行)[，,。!！?？\s]*$/m
];

// CLI: --self-check 跑分类自检，不进 stdin 流程
if (process.argv.includes('--self-check')) {
  runSelfCheck();
  process.exit(0);
}

let stdinData = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => stdinData += c);
process.stdin.on('end', () => {
  try {
    const input = stdinData.trim() ? JSON.parse(stdinData) : {};
    const sessionId = input.session_id || 'unknown';
    const transcriptPath = input.transcript_path;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      debugLog(config, 'no transcript_path');
      return process.exit(0);
    }

    const lesson = scanForLesson(transcriptPath, sessionId);
    if (lesson) {
      saveLesson(lesson);
      debugLog(config, 'lesson captured:', lesson.id);
    } else {
      debugLog(config, 'no lesson signal');
    }
    // Stop hook 顺手做：清 7 天前的 behavior state 文件，防长期堆积
    // v8：删之前先结账（efficacy.settleAndCleanup 把行为分挂回激活过的 lessons，再删文件）
    //     efficacy 模块不可用时 fallback 回原 cleanupOldStates（不结账，只清理）
    if (efficacyMod && efficacyMod.settleAndCleanup) {
      try {
        const ttl = (behaviorMod && behaviorMod.STATE_TTL_MS) || 7 * 24 * 3600 * 1000;
        const r = efficacyMod.settleAndCleanup(ttl);
        if (r.settled > 0 || r.cleaned > 0) {
          debugLog(config, `efficacy settle: settled=${r.settled} cleaned=${r.cleaned}`);
        }
      } catch (e) {
        debugLog(config, 'efficacy settleAndCleanup error:', e.message);
      }
    } else if (behaviorMod && behaviorMod.cleanupOldStates) {
      try {
        const n = behaviorMod.cleanupOldStates();
        if (n > 0) debugLog(config, `cleaned ${n} stale behavior state files`);
      } catch {}
    }
    // v7 P2：顺手跑 decay（24h 节流），让 P2 不依赖外部 cron 自动生效
    if (decayMod && decayMod.decay) {
      try {
        const throttle = path.join(BRAIN_DIR, 'state', 'last_decay_run');
        const now = Date.now();
        let lastRun = 0;
        try { lastRun = fs.statSync(throttle).mtimeMs; } catch {}
        if (now - lastRun > 24 * 3600 * 1000) {
          const r = decayMod.decay(path.join(BRAIN_DIR, 'lessons/INDEX.json'));
          fs.writeFileSync(throttle, ''); // touch mtime
          if (r.to_cooling + r.to_archive > 0) {
            debugLog(config, `decay: cooling=${r.to_cooling} archive=${r.to_archive}`);
          }
        }
      } catch (e) {
        debugLog(config, 'decay error:', e.message);
      }
    }
  } catch (e) {
    debugLog(config, 'capture-lesson error:', e.message);
  }
  process.exit(0);
});

function scanForLesson(transcriptPath, sessionId) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return null; }

  // 解析 JSONL transcript（每行一个 message）
  // ponytail: 单行 JSONL 假设 — CC 现版本是这样，将来 pretty-print 会让 JSON.parse 全失败
  //          全失败时 userMessages 为空 → 不产 lesson（哑巴坏）；按需加 stderr warning
  const lines = raw.split('\n').filter(l => l.trim());
  const userMessages = [];

  // 只看末尾 100 行
  // ponytail: 100 行限制 — 长 session 早期纠正会丢，但纠正信号关注的是"用户最近的反应"
  //          权衡选近期。不改。
  for (const line of lines.slice(-100)) {
    try {
      const msg = JSON.parse(line);
      // CC 不同版本 user 消息形态：顶层 role/type 或 nested message.role 都兜底
      const role = msg.role || msg.type || (msg.message && msg.message.role);
      if (role === 'user') {
        let content = msg.content;
        if (msg.message && msg.message.content) content = msg.message.content;
        if (Array.isArray(content)) {
          content = content.map(c => c.text || '').join(' ');
        }
        if (typeof content === 'string' && content.trim()) {
          // 关键：去掉 hook 注入的 system content（<brain-context>/<honest-loop-protocol>/<system-reminder>/<command-name>）
          // 不去掉的话 inject-context 注入的 IDENTITY 含"纠正"字样会自触发 capture
          const cleaned = stripInjectedContent(content);
          if (cleaned.trim()) {
            userMessages.push(cleaned);
          }
        }
      }
    } catch {}
  }

  if (userMessages.length === 0) return null;

  // v7.1 收紧（2026-06-25）：只对**最后一条**用户消息打分；
  // 之前拼 3 条 → 第 N 条命中 pattern 但 title/summary 记的是 N+2 → 大量 false positive
  // recent 仍保留 3 条只作 raw_signal 上下文存档（不参与判定）
  const lastMsg = userMessages[userMessages.length - 1] || '';
  const recent = userMessages.slice(-3).join('\n---\n');

  let signalScore = 0;
  for (const p of CORRECTION_PATTERNS) {
    if (p.test(lastMsg)) signalScore += 1;
  }

  // 强正面信号 → 抵消（每命中一条减 1 分），不直接 reset
  let positiveHits = 0;
  for (const p of STRONG_POSITIVE_PATTERNS) {
    if (p.test(lastMsg)) positiveHits += 1;
  }
  signalScore = Math.max(0, signalScore - positiveHits);

  debugLog(config, `signal score: ${signalScore} (positive offsets: ${positiveHits})`);
  // v7.1 阈值 ≥2：单 pattern 命中误射概率高，要求两条不同 pattern 同时打中
  // ponytail: 阈值 2，宁可漏抓不要噪音；若发现真教训漏抓多 调回 1
  if (signalScore < 2) return null;

  const date = new Date();
  const yyyymmdd = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  // 用毫秒 + pid 拼接，避免同秒/同天 1000s 间隔的 ID 碰撞
  const seq = `${date.getTime()}-${process.pid}`;

  // v7 P0：结构化字段。v8 D1：false_success 命中 → severity 直接 high（造 lesson 时判断 trigger 来源）
  const trigger = classifyTrigger(recent);

  return {
    id: `L-${yyyymmdd}-d${seq}`,
    session_id: sessionId,
    created: nowISO(),
    // v8 验收修：入口已保证 signalScore>=2，原 ">=2?high:mid" 是死分支（一切皆 high，
    // 导致 decay 的 identity 保护形同虚设）。3 分 = 命中 3 条纠正正则 = 真强信号才配 high
    severity: (trigger === 'false_success' || signalScore >= 3) ? 'high' : 'mid',
    status: 'draft',
    title: extractTitle(lastMsg),
    summary: lastMsg.slice(0, 400),
    raw_signal: recent.slice(0, 1000),
    signal_score: signalScore,
    trigger,
    // v7 P1：真实质量分（PostToolUse track-behavior.js 累计的行为指标）；
    //        track-behavior 不可用 / step<4 / state 缺失时 fallback 占位（从 signal_score 反算）
    session_behavior_score: computeBehaviorScore(sessionId, signalScore),
    behavior_metrics: snapshotBehavior(sessionId),
    // v8：本 session 激活过的 lesson ids（inject-context.js 写的 state/activated-<sid>.json）
    //     文件不存在/解析失败 → 空数组（不是错误，只是没激活记录）
    affected_rules: getActivatedLessonIds(sessionId)
  };
}

/**
 * 读本 session 激活过的 lesson ids（inject-context.js markLessonsActivated 时写的 state 文件）
 * @param {string} sessionId
 * @returns {string[]}
 */
function getActivatedLessonIds(sessionId) {
  try {
    const p = path.join(BRAIN_DIR, 'state', `activated-${sessionId}.json`);
    const parsed = JSON.parse(readFileSafe(p, '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function computeBehaviorScore(sessionId, _signalScore) {
  if (behaviorMod) {
    try {
      const state = behaviorMod.loadState(sessionId);
      const s = behaviorMod.computeScore(state);
      if (s !== null && typeof s === 'number') return s;
    } catch {}
  }
  // fallback: 没行为数据 = 真未知。给中性 0.5（既不双重惩罚，也不假装一切都好）
  // 之前从 signal_score 反算属于双重惩罚：lesson 被 capture 本身已经是负面信号
  return 0.5;
}

function snapshotBehavior(sessionId) {
  if (!behaviorMod) return null;
  try {
    const st = behaviorMod.loadState(sessionId);
    if (!st || !st.step) return null;
    return {
      step: st.step,
      first_write_step: st.first_write_step,
      validation_count: st.validation_count,
      consecutive_retry_max: st.consecutive_retry_max
    };
  } catch { return null; }
}

/**
 * v8 C3：矛盾嗅探 — 纯词面重叠，不上 embedding 不调外部服务
 * @param {string} s
 * @returns {Set<string>} token 集合（英数字 2+ 连续 或 中文 2+ 连续）
 */
function tokenize(s) {
  return new Set((s || '').toLowerCase().match(/[a-z0-9]{2,}|[一-龥]{2,}/g) || []);
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 新 lesson 的 title+summary tokens 对每条 status=confirmed && lifecycle=active 的旧 lesson 算 Jaccard
 * ponytail: 2-gram 都没上，纯词面重叠，阈值 0.35 是拍的，误报靠人眼过滤
 * 命中 → 写一行到 state/conflict-queue.jsonl 供日报/巡检冒泡，只标记不裁决
 * @param {Array} existingLessons idx.lessons（写入新条目前的快照）
 * @param {string} newId 新 lesson 的 id
 * @param {string} title
 * @param {string} summary
 * @param {{ queuePath?: string }} [opts] 测试用注入点，生产走默认真实路径
 * @returns {string[]} 撞车的旧 lesson id 数组（可能为空）
 */
function detectConflicts(existingLessons, newId, title, summary, opts = {}) {
  const newTokens = tokenize(`${title || ''} ${summary || ''}`);
  if (newTokens.size === 0 || !Array.isArray(existingLessons)) return [];

  const hits = [];
  for (const l of existingLessons) {
    if (l.status !== 'confirmed') continue;
    if (l.lifecycle && l.lifecycle !== 'active') continue;
    const oldTokens = tokenize(`${l.title || ''} ${l.summary || ''}`);
    const score = jaccard(newTokens, oldTokens);
    if (score > 0.35) hits.push({ id: l.id, score });
  }
  if (hits.length === 0) return [];

  const queuePath = opts.queuePath || path.join(BRAIN_DIR, 'state', 'conflict-queue.jsonl');
  try {
    const line = JSON.stringify({
      ts: nowISO(),
      new_id: newId,
      old_ids: hits.map(h => h.id),
      score: hits.map(h => +h.score.toFixed(2))
    }) + '\n';
    fs.appendFileSync(queuePath, line);
  } catch (e) {
    debugLog(config, 'conflict-queue append error:', e.message);
  }
  return hits.map(h => h.id);
}

/**
 * 分类纠正信号触发类型
 * 优先级：false_success > abandon_signal > explicit_correction > implicit_rephrase
 *   - false_success 最强（v8）：谎报成功——不只是没解决，是骗了人
 *   - abandon 次强：用户已失望，停止尝试纠正
 *   - explicit 居中：用户在直接指错
 *   - implicit 最弱：用户在重述/提醒（默认兜底）
 *
 * @param {string} text 拼接后的近期用户消息
 * @returns {'false_success' | 'abandon_signal' | 'explicit_correction' | 'implicit_rephrase'}
 */
function classifyTrigger(text) {
  for (const p of TRIGGER_PATTERNS.false_success) {
    if (p.test(text)) return 'false_success';
  }
  for (const p of TRIGGER_PATTERNS.abandon_signal) {
    if (p.test(text)) return 'abandon_signal';
  }
  for (const p of TRIGGER_PATTERNS.explicit_correction) {
    if (p.test(text)) return 'explicit_correction';
  }
  return 'implicit_rephrase';
}

function extractTitle(text) {
  // 取第一句或前 40 字符
  const firstSentence = text.split(/[\n。！？!?]/)[0];
  return firstSentence.slice(0, 40).trim();
}

/**
 * 去掉 cc 注入的 system content（hook output / system-reminder / command-name）
 * 不去掉的话 inject-context 注入的 IDENTITY/REFLECTION 含"纠正"字会自触发 capture
 *
 * @param {string} content - user message 原始内容
 * @returns {string} 清理后只剩用户真实输入的部分
 */
function stripInjectedContent(content) {
  if (typeof content !== 'string') return '';
  let out = content;
  // 1. 去掉 brain inject-context 注入的整个 <brain-context>...</brain-context> 块
  out = out.replace(/<brain-context>[\s\S]*?<\/brain-context>/g, '');
  // 2. 去掉 honest-loop protocol 注入
  out = out.replace(/<honest-loop-protocol>[\s\S]*?<\/honest-loop-protocol>/g, '');
  // 3. 去掉 cc system-reminder 块
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  // 4. 去掉 command-name / local-command-stdout / etc
  out = out.replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  out = out.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  out = out.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
  out = out.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  // 5. 去掉 tool_result / function_results 块
  out = out.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, '');
  out = out.replace(/<function_results>[\s\S]*?<\/function_results>/g, '');
  // 6. 兜底：把任何 lowercase 标签包起来的块全删（防 CC 升级新增 wrapper / MCP 注入新标签）
  //    用例：<ide_selection>...</ide_selection>、<paste>...</paste>、未来未知 wrapper
  //    限制 lowercase + [a-z_-] 避免误删人类文本里的 HTML 模板代码（用户真要写代码会用 ``` 包）
  out = out.replace(/<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/g, '');
  return out.trim();
}

/**
 * 自检：跑 `node capture-lesson.js --self-check`
 * 验证三个 trigger 分类各自打中样本 + 优先级正确
 * 任一断言失败 → 抛异常退出非零，hook 不安装一个坏的脚本
 */
function runSelfCheck() {
  const cases = [
    // [输入文本, 期望 trigger]
    ['算了 随便吧', 'abandon_signal'],
    ['别再这样了', 'abandon_signal'],
    ['你错了 这不对', 'explicit_correction'],
    ['又犯 又这样', 'explicit_correction'],
    ['为什么你总是降智', 'explicit_correction'],
    ['我之前说过了', 'implicit_rephrase'],
    ['你应该先 grep', 'implicit_rephrase'],
    // 优先级：abandon 文字 + explicit 文字 → abandon 胜
    ['你错了 算了随便吧', 'abandon_signal'],
    // 优先级：explicit + implicit → explicit 胜
    ['我之前说过了 你又这样', 'explicit_correction'],
    // v8 D1：谎报成功
    ['你说搞定了 结果还是不行', 'false_success'],
    ['哪里好了 根本没修好', 'false_success'],
    ['你又骗我', 'false_success'],
    // 优先级：false_success + abandon 文字同时命中 → false_success 胜（最高优先级）
    ['你说搞定了 结果还是不行 算了随便吧', 'false_success']
  ];
  let pass = 0;
  for (const [text, expected] of cases) {
    const got = classifyTrigger(text);
    const ok = got === expected;
    console.log(`${ok ? 'PASS' : 'FAIL'} | "${text}" → ${got} (expect ${expected})`);
    if (!ok) throw new Error(`classifyTrigger mismatch: ${text}`);
    pass++;
  }
  // 强正面抵消逻辑：positive 和 correction 共存时按净分判定（不再像旧版直接吞掉）
  // 强 correction (3 个不同 pattern 命中) + 单 positive → net=2，应保留
  // 命中 explicit「又这样」+ implicit「我之前说」+ implicit「你应该」
  const strongMixed = '你说得对 我之前说过了 你应该早点听 你又这样';
  const strongLesson = scanForLessonFromText(strongMixed, 'mix-strong');
  if (!strongLesson) throw new Error('strong correction must survive single positive offset');
  console.log(`PASS | strong correction survives positive (signal=${strongLesson.signal_score})`);

  // 弱平衡（1 correction + 1 positive）→ net=0，应该 return null（被吞）
  const weakMixed = '你说得对，但你错了';
  const weakLesson = scanForLessonFromText(weakMixed, 'mix-weak');
  if (weakLesson) throw new Error('balanced positive+correction should be dropped');
  console.log(`PASS | balanced positive+correction dropped`);

  // v8 D1：false_success 命中 → severity 强制 high
  const fsLesson = scanForLessonFromText('你说搞定了 结果根本不对', 'self-check-false-success');
  if (!fsLesson) throw new Error('false_success text should produce a lesson');
  if (fsLesson.trigger !== 'false_success') throw new Error(`expected trigger=false_success got ${fsLesson.trigger}`);
  if (fsLesson.severity !== 'high') throw new Error(`false_success lesson severity should be high, got ${fsLesson.severity}`);
  console.log(`PASS | D1 false_success → severity=${fsLesson.severity}`);

  // stripInjectedContent 兜底通配：未知新 wrapper 标签里的纠正文字不该自激
  const stripped = stripInjectedContent('<future-wrapper>你又这样了 又错了</future-wrapper>剩余用户输入');
  if (stripped.includes('你又这样了')) throw new Error('lowercase wrapper not stripped');
  if (!stripped.includes('剩余用户输入')) throw new Error('user text accidentally stripped');
  console.log(`PASS | strip lowercase wrapper: "${stripped}"`);

  // 字段健康检查：score ∈ [0,1]、rules 是数组、metrics 形态正确
  // v7.1: 阈值升到 2，文本要命中 ≥2 不同 pattern（"你又这样" + "降智"）
  const fakeLesson = scanForLessonFromText('你又这样 又降智了', 'self-check-cap');
  if (!fakeLesson) throw new Error('scan failed on obvious correction');
  if (typeof fakeLesson.session_behavior_score !== 'number') throw new Error('session_behavior_score not number');
  if (fakeLesson.session_behavior_score < 0 || fakeLesson.session_behavior_score > 1) {
    throw new Error('session_behavior_score out of [0,1]');
  }
  if (!Array.isArray(fakeLesson.affected_rules)) throw new Error('affected_rules not array');
  if (fakeLesson.behavior_metrics !== null && typeof fakeLesson.behavior_metrics !== 'object') {
    throw new Error('behavior_metrics must be object or null');
  }
  console.log(`PASS | structured fields: score=${fakeLesson.session_behavior_score.toFixed(2)} metrics=${JSON.stringify(fakeLesson.behavior_metrics)} rules=${JSON.stringify(fakeLesson.affected_rules)}`);

  // 集成自检：track-behavior 模块加载成功 + 一个 session 跑完整真生产路径
  if (behaviorMod) {
    const sid = `selfcheck-int-${Date.now()}`;
    // 跑 5 步：4 个 Write + 1 个 Edit → 早写、零验证、连续 = 触发所有惩罚
    // 直接调真 updateState 而不是影子复制，确保测的就是生产逻辑
    for (let i = 0; i < 4; i++) behaviorMod.updateState(sid, 'Write', '');
    behaviorMod.updateState(sid, 'Edit', '');
    // v7.1: 需命中 ≥2 不同 pattern（explicit "你错了" + implicit "你应该"）
    const lesson2 = scanForLessonFromText('你错了 你应该先 grep', sid);
    if (!lesson2) throw new Error('scan failed in integration test');
    if (lesson2.behavior_metrics === null) throw new Error('behavior_metrics should not be null after 5 steps');
    if (lesson2.behavior_metrics.step !== 5) throw new Error(`step expected 5 got ${lesson2.behavior_metrics.step}`);
    if (lesson2.behavior_metrics.first_write_step !== 1) throw new Error('first_write_step expected 1');
    console.log(`PASS | integration: score=${lesson2.session_behavior_score.toFixed(2)} metrics=${JSON.stringify(lesson2.behavior_metrics)}`);
    // 清理 state 文件
    try { fs.unlinkSync(behaviorMod.statePath(sid)); } catch {}
  } else {
    console.log('SKIP | integration: track-behavior 模块未加载（不影响 fallback）');
  }

  // v8 C1/C3：invalidated/superseded_by 字段 + 矛盾嗅探
  // 构造两条高重叠 lesson，断言标记生效（用 tmp 目录下的 conflict-queue.jsonl，不碰真实 state）
  {
    const os = require('os');
    const tmpQueue = path.join(os.tmpdir(), `conflict-queue-selfcheck-${Date.now()}.jsonl`);
    const existing = [
      { id: 'L-old-confirmed', status: 'confirmed', lifecycle: 'active',
        title: '凌晨规则 明天等于当天白天', summary: '凌晨对话说明天 指的是当天白天不是日历下一天' },
      { id: 'L-old-rejected', status: 'rejected', lifecycle: 'archive',
        title: '凌晨规则 明天等于当天白天', summary: '凌晨对话说明天 指的是当天白天不是日历下一天' }
    ];
    // 高重叠：词面几乎相同，应命中 confirmed/active 那条，不该命中 rejected 那条
    const conflictIds = detectConflicts(existing, 'L-new-test', '凌晨规则 明天就是当天白天',
      '凌晨对话说明天 指的是当天白天不是日历下一天', { queuePath: tmpQueue });
    if (!conflictIds.includes('L-old-confirmed')) throw new Error('high-overlap lesson should be flagged as conflict');
    if (conflictIds.includes('L-old-rejected')) throw new Error('rejected lesson should not be considered for conflict');
    if (!fs.existsSync(tmpQueue)) throw new Error('conflict-queue.jsonl should be written on conflict hit');
    const queueLine = JSON.parse(fs.readFileSync(tmpQueue, 'utf-8').trim().split('\n')[0]);
    if (queueLine.new_id !== 'L-new-test') throw new Error('conflict-queue new_id mismatch');
    if (!Array.isArray(queueLine.old_ids) || !queueLine.old_ids.includes('L-old-confirmed')) {
      throw new Error('conflict-queue old_ids missing expected id');
    }
    console.log(`PASS | C3 conflict detection: flagged=${JSON.stringify(conflictIds)}, queue written`);

    // 低重叠：不该误报
    const noConflict = detectConflicts(existing, 'L-new-unrelated', '今天天气不错', '出去走走吧', { queuePath: tmpQueue });
    if (noConflict.length !== 0) throw new Error('unrelated lesson should not be flagged as conflict');
    console.log('PASS | C3 no false positive on unrelated text');

    try { fs.unlinkSync(tmpQueue); } catch {}
  }

  console.log(`\nself-check: ${pass + (behaviorMod ? 2 : 1) + 2} pass`);
}

// 注：旧版 writeStep 复制了 track-behavior 的累计逻辑（影子代码），
//    self-check 测的不是真生产路径——已删除，集成测试直接调 behaviorMod.updateState。

/**
 * 测试辅助：跳过 transcript 解析，直接给一段文本走完打分 + 结构化流程
 * 仅 self-check 用，不影响生产路径
 */
function scanForLessonFromText(text, sessionId) {
  let signalScore = 0;
  for (const p of CORRECTION_PATTERNS) if (p.test(text)) signalScore += 1;
  // 与生产路径一致：强正面抵消（不再直接 return null）
  let positiveHits = 0;
  for (const p of STRONG_POSITIVE_PATTERNS) if (p.test(text)) positiveHits += 1;
  signalScore = Math.max(0, signalScore - positiveHits);
  if (signalScore < 2) return null;
  const trigger = classifyTrigger(text);
  return {
    id: 'L-test', session_id: sessionId, created: nowISO(),
    // v8 D1: false_success 命中 → severity 直接 high，与生产路径一致（含验收修：>=3 才 high）
    severity: (trigger === 'false_success' || signalScore >= 3) ? 'high' : 'mid', status: 'draft',
    title: text.slice(0, 40), summary: text, raw_signal: text,
    signal_score: signalScore,
    trigger,
    // 走真实生产路径（带 P1 行为数据），保证 self-check 测的就是 hook 实际产物
    session_behavior_score: computeBehaviorScore(sessionId, signalScore),
    behavior_metrics: snapshotBehavior(sessionId),
    affected_rules: []
  };
}

function saveLesson(lesson) {
  const date = new Date();
  const yyyymm = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
  const lessonsDir = path.join(BRAIN_DIR, 'lessons');
  const monthFile = path.join(lessonsDir, `${yyyymm}.md`);
  const indexFile = path.join(lessonsDir, 'INDEX.json');

  // 追加到月文件
  const block =
`
## ${lesson.id} | ${lesson.title} | ${lesson.severity} | DRAFT

**created:** ${lesson.created}
**session:** ${lesson.session_id}
**signal_score:** ${lesson.signal_score}
**trigger:** ${lesson.trigger}
**session_behavior_score:** ${lesson.session_behavior_score.toFixed(2)}
**behavior_metrics:** ${lesson.behavior_metrics ? JSON.stringify(lesson.behavior_metrics) : 'unavailable (track-behavior 未生效或 step<4)'}
**affected_rules:** ${JSON.stringify(lesson.affected_rules)}

### 摘要
${lesson.summary}

### 原始信号
\`\`\`
${lesson.raw_signal}
\`\`\`

---
`;
  try {
    fs.appendFileSync(monthFile, block);
  } catch (e) {
    debugLog(config, 'failed to append month file:', e.message);
    return;
  }

  // 更新 INDEX
  let idx;
  try { idx = JSON.parse(readFileSafe(indexFile, '{"lessons":[]}')); }
  catch { idx = { lessons: [] }; }

  if (!Array.isArray(idx.lessons)) idx.lessons = [];

  idx.lessons.unshift({
    id: lesson.id,
    title: lesson.title,
    severity: lesson.severity,
    status: lesson.status,
    summary: lesson.summary.slice(0, 200),
    created: lesson.created,
    file: `${yyyymm}.md`,
    // v7 P0 结构化字段
    trigger: lesson.trigger,
    session_behavior_score: lesson.session_behavior_score,
    affected_rules: lesson.affected_rules,
    // v7 P2 生命周期（status 是审核状态 draft/confirmed/rejected；lifecycle 是活跃度）
    lifecycle: 'active',
    last_activated: lesson.created, // 新 lesson 默认当作"刚创建即激活"
    activation_count: 1,             // 与 last_activated 一致：算"刚创建即第 1 次激活"
    // v8 C1：时序字段——老条目不回填，缺失 = null 语义
    invalidated: null,
    superseded_by: null,
    // v8 C3：矛盾嗅探（与旧 confirmed/active lesson 词面撞车时标记，只标记不裁决）
    possible_conflict_with: detectConflicts(idx.lessons, lesson.id, lesson.title, lesson.summary)
  });

  // 只保留最近 200 条（draft 自动清理）
  // ponytail: INDEX 截断 — 月文件保留全部 lesson，INDEX 只索引近期 200 条；
  //          老 lesson 仍在月文件可以 grep，INDEX 优先承担"最近发生过什么"的检索
  idx.lessons = idx.lessons.slice(0, 200);

  try {
    writeFileAtomic(indexFile, JSON.stringify(idx, null, 2));
  } catch (e) {
    debugLog(config, 'failed to write index:', e.message);
  }
}
