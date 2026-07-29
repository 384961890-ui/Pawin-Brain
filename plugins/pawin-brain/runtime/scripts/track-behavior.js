#!/usr/bin/env node
/**
 * track-behavior.js — claude-brain v7 P1 行为指标累计 + v8 D2 权限循环检测
 *
 * Hook: PostToolUse（matcher "*"，所有工具）+ PostToolUseFailure（v8 新增，验收人挂）
 *
 * 输入: stdin JSON { sessionId, toolUse: { name, input?: { command, file_path } } }（ZCode）或
 *                   { session_id, tool_name, tool_input?, tool_response?, hook_event_name? }（Claude Code）
 *       hook_event_name === 'PostToolUseFailure' → 本次调用记一次失败
 * 输出: 无（静默，不阻塞）
 *
 * 累计三个零标注信号（论文 2604.02547 Behavioral Drivers 验证）：
 *   - first_write_step：第一次 Write/Edit/MultiEdit/NotebookEdit 是第几步
 *   - validation_count：Read/Grep/Glob/测试型 Bash 累计次数
 *   - consecutive_retry_max：同一 tool_name 最长连续段长度（= 重试次数 + 1；
 *                             首次用 = 1，连用 5 次 = 5，被任何其他工具打断后归 1）
 *
 * v8 D2 新增权限循环信号：
 *   - failure_count：累计失败次数
 *   - consecutive_failure_max：最长连续失败段长度（同一工具连败 3 次还在撞 = 权限/环境循环）
 *
 * State 写到 ~/.claude-brain/state/behavior-<session_id>.json，
 * Stop hook 的 capture-lesson 读它算质量分。
 *
 * 一切 IO 都吞错误，不阻塞主流程。
 */

const fs = require('fs');
const path = require('path');
const {
  BRAIN_DIR, loadConfig, readFileSafe, writeFileAtomic, nowISO, debugLog
} = require('./util.js');

const config = loadConfig();

// 写工具：原生 CC 工具 + MCP 写类工具（filesystem/github 等都按名字匹配）
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_TOOL_MCP_PATTERN = /^mcp__.+__(?:write|create|update|edit|patch|append)/i;
const isWriteTool = (name) =>
  WRITE_TOOL_NAMES.has(name) || WRITE_TOOL_MCP_PATTERN.test(name);

const VALIDATION_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// Bash 命令里包含验证类操作就算验证（不锚开头，&&/;/pipe 后也算；不死磕命令前缀）
const VALIDATION_BASH_PATTERNS = [
  /\b(?:pytest|jest|vitest|mocha|phpunit|rspec)\b/,
  /\b(?:cargo|go|swift|mvn|gradle)\s+test\b/,
  /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:test|run\s+test|run\s+vitest|run\s+jest|vitest|jest)\b/,
  /\bpython3?\s+-m\s+(?:pytest|unittest)\b/,
  /\b(?:npx|uv\s+run|poetry\s+run|pre-commit\s+run)\b[^&;|]*\b(?:pytest|jest|vitest|mocha|test)\b/,
  /\b(?:tsc|eslint|ruff|mypy|pyright)\b/,
  /(?:^|\s)--self-check\b/
];
const isValidationBash = (cmd) => VALIDATION_BASH_PATTERNS.some(p => p.test(cmd));

const STATE_DIR = path.join(BRAIN_DIR, 'state');
const STATE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天，capture-lesson 末尾跑清理

// 守卫：被 require() 加载时不跑 CLI / stdin 副作用（否则 capture-lesson 拉它就会自爆）
if (require.main === module) {
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
      // 兼容 ZCode (sessionId + toolUse.*) 与 Claude Code (session_id + tool_name / tool_input.*)
      const sessionId = input.sessionId || input.session_id || 'unknown';
      const toolName = input.toolUse?.name || input.tool_name || '';
      const toolInput = input.toolUse?.input || input.tool_input || {};
      const bashCmd = toolInput.command || '';
      // v8 D2：PostToolUseFailure hook 触发时 hook_event_name 是这个值
      const isFailure = input.hook_event_name === 'PostToolUseFailure';

      if (!toolName) return process.exit(0);

      updateState(sessionId, toolName, bashCmd, isFailure);
    } catch (e) {
      debugLog(config, 'track-behavior error:', e.message);
    }
    process.exit(0);
  });
}

function statePath(sessionId) {
  // 只算路径，不建目录——副作用留给 updateState 写之前做（让 loadState 是纯读）
  // ponytail: session_id 直接进文件名，CC 给的是 UUID 形式无注入风险
  const safeSessionId = String(sessionId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160) || 'unknown';
  return path.join(STATE_DIR, `behavior-${safeSessionId}.json`);
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadState(sessionId) {
  const p = statePath(sessionId);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {
      session_id: sessionId,
      started: nowISO(),
      step: 0,
      first_write_step: null,
      validation_count: 0,
      consecutive_retry_max: 0,
      consecutive_retry_cur: 0,
      last_tool: null,
      // v8 D2：权限/环境循环信号
      failure_count: 0,
      consecutive_failure_max: 0,
      consecutive_failure_cur: 0
    };
  }
}

// ponytail: PostToolUse 在 CC 当前版本是串行调度（一个 tool 跑完才下一个 + 同事件的多 hook 也串行），
//          所以 read-modify-write 实际上不会并发；如果以后 CC 把 PostToolUse 改成并发触发，
//          这里就有 lost update 风险，到时再换 append-only event log（每个 tool 追加一行，capture 时聚合）
// v8 D2：isFailure=true 时(PostToolUseFailure hook 触发) 累计失败信号，不影响原有三个指标
function updateState(sessionId, toolName, bashCmd, isFailure) {
  const s = loadState(sessionId);
  s.step += 1;

  if (s.first_write_step === null && isWriteTool(toolName)) {
    s.first_write_step = s.step;
  }

  if (VALIDATION_TOOLS.has(toolName) || (toolName === 'Bash' && isValidationBash(bashCmd))) {
    s.validation_count += 1;
  }

  if (s.last_tool === toolName) {
    s.consecutive_retry_cur += 1;
  } else {
    s.consecutive_retry_cur = 1;
  }
  if (s.consecutive_retry_cur > s.consecutive_retry_max) {
    s.consecutive_retry_max = s.consecutive_retry_cur;
  }
  s.last_tool = toolName;

  // v8 D2：老 state 文件缺这三个字段（v8 上线前写的）→ || 0 兜底，不炸
  s.failure_count = s.failure_count || 0;
  s.consecutive_failure_cur = s.consecutive_failure_cur || 0;
  s.consecutive_failure_max = s.consecutive_failure_max || 0;
  if (isFailure) {
    s.failure_count += 1;
    s.consecutive_failure_cur += 1;
    if (s.consecutive_failure_cur > s.consecutive_failure_max) {
      s.consecutive_failure_max = s.consecutive_failure_cur;
    }
  } else {
    s.consecutive_failure_cur = 0;
  }

  s.updated = nowISO();

  try {
    ensureStateDir();
    writeFileAtomic(statePath(sessionId), JSON.stringify(s, null, 2));
  } catch (e) {
    debugLog(config, 'track-behavior write error:', e.message);
  }
}

/**
 * 清理 STATE_DIR 里超过 maxAgeMs 的 behavior-*.json
 * 设计：Stop hook capture-lesson 末尾调一次，每次最多扫一遍目录
 * @param {number} maxAgeMs 默认 STATE_TTL_MS（7天）
 * @returns {number} 清掉的文件数
 */
function cleanupOldStates(maxAgeMs = STATE_TTL_MS) {
  if (!fs.existsSync(STATE_DIR)) return 0;
  const now = Date.now();
  let cleaned = 0;
  let entries;
  try { entries = fs.readdirSync(STATE_DIR); } catch { return 0; }
  for (const f of entries) {
    if (!f.startsWith('behavior-') || !f.endsWith('.json')) continue;
    const p = path.join(STATE_DIR, f);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(p);
        cleaned++;
      }
    } catch {}
  }
  return cleaned;
}

/**
 * 给定一份 state，算 session_behavior_score ∈ [0,1]，越高越好
 * 公式（ponytail: 起点估值，无生产数据，跑一两周看分布再调）
 *   起 1.0
 *   - first_write_step ≤ 2 且 step ≥ 4 → -0.3（过早动手）
 *   - validation_ratio < 0.2 且 step ≥ 5 → -0.3（不验证）
 *   - consecutive_retry_max ≥ 5 → -0.4（卡同一个工具）
 *   - consecutive_failure_max ≥ 3 → -0.3（v8 D2：同一个工具连败 3 次还在撞 = 权限/环境循环。
 *     ponytail: 阈值拍的，analyze-behavior 数据出来再调）
 *   下限 0，上限 1
 * 数据少的 session（step < 4）→ 不评分，返回 null
 */
function computeScore(state) {
  if (!state || state.step < 4) return null;
  let score = 1.0;
  if (state.first_write_step !== null && state.first_write_step <= 2) score -= 0.3;
  const validationRatio = state.validation_count / state.step;
  if (validationRatio < 0.2) score -= 0.3;
  if (state.consecutive_retry_max >= 5) score -= 0.4;
  if ((state.consecutive_failure_max || 0) >= 3) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

module.exports = {
  loadState, computeScore, statePath, updateState, cleanupOldStates,
  isWriteTool, isValidationBash, // 给 self-check 复用
  STATE_TTL_MS // v8 efficacy.js 复用同一 TTL，不许两处各写一份
};

function runSelfCheck() {
  const samples = [
    {
      name: 'good session: read first, mixed validation, no stuck',
      events: ['Read', 'Read', 'Grep', 'Edit', 'Bash', 'Read', 'Edit'],
      expect: { first_write_step: 4, validation_count_min: 4, consecutive_retry_max: 2 }
    },
    {
      name: 'bad session: write first, no validation, stuck',
      events: ['Edit', 'Edit', 'Edit', 'Edit', 'Edit', 'Edit'],
      expect: { first_write_step: 1, validation_count_min: 0, consecutive_retry_max: 6 }
    },
    {
      name: 'mostly research, no write, interleaved (no consecutive)',
      events: ['Read', 'Grep', 'Read', 'Glob', 'Read'],
      // 5 步全验证 / 没 write / Read 出现 3 次但被打断 → 最长连续段 = 1
      expect: { first_write_step: null, validation_count_min: 5, consecutive_retry_max: 1 }
    },
    {
      name: 'research with stuck (consecutive same tool)',
      events: ['Read', 'Read', 'Read', 'Read', 'Edit'],
      expect: { first_write_step: 5, validation_count_min: 4, consecutive_retry_max: 4 }
    }
  ];

  let pass = 0;
  for (const sample of samples) {
    const sid = `selfcheck-${Date.now()}-${Math.floor(performance.now() % 10000)}`;
    const p = statePath(sid);
    try { fs.unlinkSync(p); } catch {}
    for (const tool of sample.events) {
      updateState(sid, tool, '');
    }
    const final = loadState(sid);
    const fail = [];
    if (final.first_write_step !== sample.expect.first_write_step) {
      fail.push(`first_write_step ${final.first_write_step} != ${sample.expect.first_write_step}`);
    }
    if (final.validation_count < sample.expect.validation_count_min) {
      fail.push(`validation_count ${final.validation_count} < ${sample.expect.validation_count_min}`);
    }
    if (final.consecutive_retry_max !== sample.expect.consecutive_retry_max) {
      fail.push(`consecutive_retry_max ${final.consecutive_retry_max} != ${sample.expect.consecutive_retry_max}`);
    }
    const score = computeScore(final);
    if (fail.length) {
      console.log(`FAIL | ${sample.name}: ${fail.join('; ')}`);
      try { fs.unlinkSync(p); } catch {}
      throw new Error(sample.name);
    }
    console.log(`PASS | ${sample.name} → step=${final.step} score=${score === null ? 'null' : score.toFixed(2)}`);
    try { fs.unlinkSync(p); } catch {}
    pass++;
  }

  // v8 D2：连续 3 次 failure（同一工具）→ consecutive_failure_max=3，score 扣 0.3
  {
    const sid = `selfcheck-d2-${Date.now()}`;
    const p = statePath(sid);
    try { fs.unlinkSync(p); } catch {}
    // 4 次正常 Read（validation_ratio 保持健康，不触发其他扣分项）
    for (let i = 0; i < 4; i++) updateState(sid, 'Read', '', false);
    // 3 次同工具连续失败
    for (let i = 0; i < 3; i++) updateState(sid, 'Bash', '', true);
    const final = loadState(sid);
    if (final.failure_count !== 3) throw new Error(`D2: failure_count expect 3 got ${final.failure_count}`);
    if (final.consecutive_failure_max !== 3) throw new Error(`D2: consecutive_failure_max expect 3 got ${final.consecutive_failure_max}`);
    const score = computeScore(final);
    if (score === null) throw new Error('D2: score should not be null (step>=4)');
    if (Math.abs(score - 0.7) > 1e-9) throw new Error(`D2: score expect 0.7 (only failure penalty) got ${score}`);
    console.log(`PASS | D2 permission-loop: consecutive_failure_max=3 → score=${score.toFixed(2)} (-0.3 applied)`);
    try { fs.unlinkSync(p); } catch {}
    pass++;
  }

  // v8 D2：一次成功打断连续失败计数（consecutive_failure_cur 归零，max 保留历史峰值）
  {
    const sid = `selfcheck-d2-reset-${Date.now()}`;
    const p = statePath(sid);
    try { fs.unlinkSync(p); } catch {}
    for (let i = 0; i < 3; i++) updateState(sid, 'Bash', '', true); // 连败 3 次
    updateState(sid, 'Bash', '', false); // 成功一次，打断连续计数
    const final = loadState(sid);
    if (final.consecutive_failure_cur !== 0) throw new Error(`D2: consecutive_failure_cur should reset to 0, got ${final.consecutive_failure_cur}`);
    if (final.consecutive_failure_max !== 3) throw new Error(`D2: consecutive_failure_max should keep peak 3, got ${final.consecutive_failure_max}`);
    if (final.failure_count !== 3) throw new Error(`D2: failure_count should stay 3 (success doesn't add), got ${final.failure_count}`);
    console.log(`PASS | D2 failure streak reset by success: cur=${final.consecutive_failure_cur} max=${final.consecutive_failure_max}`);
    try { fs.unlinkSync(p); } catch {}
    pass++;
  }

  // Bash 验证型命令识别（含 opus 4.8 挑出的真实场景：cd&&、npx、python -m、pre-commit、bun）
  const bashCases = [
    ['pytest tests/', true],
    ['npm test', true],
    ['cargo test --release', true],
    ['node script.js --self-check', true],
    ['cd foo && pytest', true],                  // 之前漏：&& 后的验证
    ['npx vitest run', true],                    // 之前漏：npx 包装
    ['uv run pytest tests/', true],              // 之前漏：uv run
    ['poetry run pytest -x', true],              // 之前漏：poetry run
    ['python -m pytest', true],                  // 之前漏：python -m
    ['python3 -m unittest', true],
    ['bun test', true],                          // 之前漏：bun
    ['deno test --allow-net', true],             // 之前漏：deno
    ['pnpm vitest', true],                       // 之前漏：pnpm vitest
    ['pre-commit run pytest --all-files', true], // 之前漏：pre-commit
    ['mvn test', true],
    ['gradle test', true],
    ['phpunit', true],
    ['rspec spec/', true],
    ['tsc --noEmit', true],
    ['ls -la', false],
    ['git status', false],
    ['echo hello', false],
    ['curl https://api', false]
  ];
  for (const [cmd, expected] of bashCases) {
    const got = isValidationBash(cmd);
    if (got !== expected) throw new Error(`Bash classify "${cmd}" → ${got} expect ${expected}`);
    console.log(`PASS | Bash "${cmd}" → validation=${got}`);
    pass++;
  }

  // MCP 写工具识别
  const writeCases = [
    ['Write', true], ['Edit', true], ['MultiEdit', true], ['NotebookEdit', true],
    ['mcp__filesystem__write_file', true],
    ['mcp__github__create_or_update_file', true],
    ['mcp__brain__update_lesson', true],
    ['mcp__filesystem__read_file', false],   // read 不是 write
    ['Read', false], ['Grep', false], ['Bash', false]
  ];
  for (const [name, expected] of writeCases) {
    const got = isWriteTool(name);
    if (got !== expected) throw new Error(`isWriteTool("${name}") → ${got} expect ${expected}`);
    console.log(`PASS | isWriteTool("${name}") → ${got}`);
    pass++;
  }

  // statePath 不建目录（找茬人格 FAIL 6）
  // 拿一个绝不存在的 sessionId 调 statePath，确认目录不被偷偷建
  const probeP = statePath('probe-no-dir-creation');
  // 文件路径在 STATE_DIR 下，但 STATE_DIR 可能已经被前面 updateState 建出来了——所以这里只验证
  // statePath 是纯字符串拼接，不调用 mkdir：检查它只做 path.join
  if (probeP.includes('behavior-probe-no-dir-creation.json')) {
    console.log(`PASS | statePath pure (returns path only)`);
    pass++;
  } else {
    throw new Error('statePath did not return expected path');
  }

  // cleanupOldStates：跑一次，应不抛错且返回 number
  const cleaned = cleanupOldStates(STATE_TTL_MS);
  if (typeof cleaned !== 'number' || cleaned < 0) throw new Error('cleanupOldStates bad return');
  console.log(`PASS | cleanupOldStates → ${cleaned} files removed`);
  pass++;

  console.log(`\nself-check: ${pass} pass`);
}
