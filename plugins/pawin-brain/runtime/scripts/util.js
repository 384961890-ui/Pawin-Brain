/**
 * util.js — claude-brain v2.0 共用工具
 * 纯 Node 标准库，零 npm 依赖。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');
const os = require('os');

const HOME = os.homedir();
const BRAIN_DIR = path.resolve(
  process.env.CLAUDE_BRAIN_DIR || path.join(HOME, '.claude-brain')
);
const CONFIG_PATH = path.join(BRAIN_DIR, 'config.json');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p === '~') return HOME;
  return p;
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    for (const key of Object.keys(cfg)) {
      if (typeof cfg[key] === 'string') cfg[key] = expandHome(cfg[key]);
    }
    return cfg;
  } catch (e) {
    return {
      qmd_enabled: false,
      max_lessons_inject: 3,
      max_recall_chars: 200,
      qmd_timeout_ms: 1500,
      qmd_top_k: 3
    };
  }
}

function readFileSafe(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return fallback; }
}

function writeFileAtomic(p, content) {
  const directory = path.dirname(p);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p);
    if (process.platform !== 'win32') fs.chmodSync(p, 0o600);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function loadLessons(indexPath) {
  try {
    const idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}'));
    const lessons = idx.lessons || [];
    // confirmed 优先，按 severity (high > mid > low)，再按 created 倒序
    const sevWeight = { high: 3, mid: 2, low: 1 };
    return lessons
      .filter(l => l.status !== 'rejected')
      // v7 P2: cooling/archive 不再注入（lifecycle 缺失 = 老数据 = active 兜底）
      .filter(l => !l.lifecycle || l.lifecycle === 'active')
      // v8 C2: 被判定作废/被新条目取代的老 lesson 不再注入（缺失 = null 语义 = 正常放行）
      .filter(l => !l.invalidated && !l.superseded_by)
      .sort((a, b) => {
        if (a.status === 'confirmed' && b.status !== 'confirmed') return -1;
        if (b.status === 'confirmed' && a.status !== 'confirmed') return 1;
        const sa = sevWeight[a.severity] || 0;
        const sb = sevWeight[b.severity] || 0;
        if (sa !== sb) return sb - sa;
        return (b.created || '').localeCompare(a.created || '');
      });
  } catch { return []; }
}

// mkdir 是原子操作（POSIX 保证）—— 用它当锁，比 lockfile 库简单也够用。
// sleepSync 用 Atomics.wait 真睡眠（不是 busy-spin 烧 CPU）等锁。
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * withLock(lockDir, fn) — mkdir 锁 + 重试 + 超时放弃
 * 抢到锁才跑 fn()，跑完（或抛错）无条件释放锁（rmdir）。
 * 抢不到锁（重试次数耗尽）→ { ok: false }，调用方据此决定"这次不改也行"。
 * 这是 hook 里的同步调用，不能真的无限等——放弃不阻塞主流程比数据准更重要。
 */
function withLock(lockDir, fn, opts = {}) {
  const maxRetries = opts.maxRetries ?? 20;
  const retryDelayMs = opts.retryDelayMs ?? 10;
  let acquired = false;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // 不是"锁被占" 是别的 fs 错误 — 别死等
      sleepSync(retryDelayMs);
    }
  }
  if (!acquired) return { ok: false };
  try {
    return { ok: true, result: fn() };
  } finally {
    try { fs.rmdirSync(lockDir); } catch {}
  }
}

/**
 * v7 P2: 标记 lesson 被激活（注入到 LLM context）
 * @param {string} indexPath INDEX.json 路径
 * @param {string[]} lessonIds 本次被注入的 lesson id 数组
 * @returns {number} 实际标记成功的条数
 *
 * 并发保护（2026-07-22 加，替换旧的"同步读改写无锁"版本）：
 *   mkdir 锁目录（`${indexPath}.lock`，POSIX 原子）保证同一时刻只有一个进程能改 INDEX.json。
 *   重试 20 次 × 10ms ≈ 200ms 窗口内抢锁；抢不到直接放弃本次标记，返回 0，不阻塞 hook。
 *   旧注释低估了严重度（"counter 偶尔少 1 没关系"）——实测双进程并发无锁版本能丢 20%-80%
 *   的计数，且 last_activated 被并发写覆盖会让热门 lesson 反而更易被 decay 错杀。上锁后
 *   两个问题一起解决，不再是"观察 1-2 周再说"的待办。
 */
function markLessonsActivated(indexPath, lessonIds) {
  if (!Array.isArray(lessonIds) || lessonIds.length === 0) return 0;
  const lockDir = `${indexPath}.lock`;
  const { ok, result } = withLock(lockDir, () => {
    let idx;
    try { idx = JSON.parse(readFileSafe(indexPath, '{"lessons":[]}')); }
    catch { return 0; }
    if (!Array.isArray(idx.lessons)) return 0;

    const idSet = new Set(lessonIds);
    const now = new Date().toISOString();
    let updated = 0;
    for (const l of idx.lessons) {
      if (idSet.has(l.id)) {
        l.last_activated = now;
        l.activation_count = (l.activation_count || 0) + 1;
        updated++;
      }
    }
    if (updated === 0) return 0;
    try {
      writeFileAtomic(indexPath, JSON.stringify(idx, null, 2));
    } catch { return 0; }
    return updated;
  });
  return ok ? result : 0;
}

// 同步包装：用于现有调用方（注入 hook 是 stdin 异步流，wait 是 OK 的）
//
// v3 分层召回（2026-06-08 加入）：
//   - endpoint 默认 '/search_fast' = 纯 embedding，warm ~1.5s，hook 注入用这条
//   - endpoint '/search'           = embedding + reranker，~30-90s，精排深查用这条
//   - 超时按 endpoint 分别取：fast 用 qmd_fast_timeout_ms (默认 5s)
//                            search 用 qmd_timeout_ms        (默认 45s)
//
// 2026-07-22 改：execSync('curl ...') → Node http 模块直连（原 qmdSearchHttp 的思路，
//   死函数已删）。理由：省一次进程 fork/exec 开销，config 里的 port/timeout 不再靠字符串
//   插值拼进 shell 命令（curl 版本本身没有注入漏洞——URL 已 encodeURIComponent 且走
//   execFileSync 会更安全，但用 http 模块从根上不再有 shell 这一层）。改成异步（Promise），
//   调用方（inject-context.js）已同步改为 await。返回形状与 .failed 语义与旧版完全一致。
function qmdSearch(query, config, endpoint) {
  return new Promise((resolve) => {
    if (!config.qmd_enabled) { resolve([]); return; }
    const topK = config.qmd_top_k || 3;
    const port = config.qmd_daemon_port || 18765;
    const ep = endpoint || '/search_fast';
    const timeoutMs = ep === '/search_fast'
      ? (config.qmd_fast_timeout_ms || 5000)
      : (config.qmd_timeout_ms || 45000);
    const url = `http://127.0.0.1:${port}${ep}?query=${encodeURIComponent(query)}&top_k=${topK}`;

    let settled = false;
    const finish = (fn) => { if (!settled) { settled = true; fn(); } };
    const fail = () => {
      // daemon 不可用/超时 — 7/20 改：不再静默空（检索静默返回空是大忌 铁律 7/04）
      // 返回带 failed 标记的空数组 调用方据此区分"真没有"和"没查成"
      const empty = [];
      empty.failed = `${ep} 查询失败（daemon 不可用或超时 ${timeoutMs}ms）`;
      resolve(empty);
    };

    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          const results = (obj.results || []).map(r => ({
            text: r.text,
            // 兼容多种格式：/search_fast 返回 source+file_path，旧 /search 返回 file
            file: r.source || r.file || r.file_path,
            score: r.score,
          }));
          finish(() => resolve(results));
        } catch { finish(fail); }
      });
    });
    req.on('error', () => finish(fail));
    req.on('timeout', () => { req.destroy(); finish(fail); });
  });
}

// grep 免费地板（2026-07-20 加入）：
//   只在 default intent（六条正则一条没命中的兜底路径）生效，其余 intent 不碰。
//   整句字面量匹配 2 个固定小索引文件，不猜关键词（中文无词界，猜=又发明一套启发式）。
//   200ms 硬超时、命中最多 2 条、每条 150 字——不是置信度判断，是"有没有命中"的二元开关。
function grepFloor(prompt, config) {
  if (!config || config.grep_floor_enabled === false) return { hit: false };
  if (!prompt || prompt.length < 6) return { hit: false };
  const targets = [
    path.join(BRAIN_DIR, 'lessons/INDEX.json'),
    path.join(process.env.MEMORY_DIR || path.join(BRAIN_DIR, 'memory'), 'MEMORY.md'),
  ].filter(p => fs.existsSync(p));
  if (targets.length === 0) return { hit: false };
  try {
    const out = execFileSync('grep', ['-F', '-h', '-m', '2', prompt, ...targets], {
      encoding: 'utf-8',
      timeout: 200,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2);
    if (lines.length === 0) return { hit: false };
    return {
      hit: true,
      snippets: lines.map(l => ({ text: l.slice(0, 150), file: 'grep-floor' })),
    };
  } catch {
    // grep 无匹配退出码 1 / 超时 / 文件读不到 —— 统一当没命中，静默回落到 QMD
    return { hit: false };
  }
}

function nowISO() {
  return new Date().toISOString();
}

function nowReadable(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function debugLog(config, ...args) {
  if (config && config.debug) {
    const logPath = path.join(BRAIN_DIR, 'debug.log');
    fs.appendFileSync(logPath, `[${nowISO()}] ${args.join(' ')}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(logPath, 0o600);
  }
}

module.exports = {
  HOME, BRAIN_DIR, CONFIG_PATH,
  expandHome, loadConfig, readFileSafe, writeFileAtomic,
  loadLessons, markLessonsActivated, qmdSearch, grepFloor, nowISO, nowReadable, debugLog
};
