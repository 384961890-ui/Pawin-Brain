#!/usr/bin/env node
/**
 * ingest.js — claude-brain v5 多模态 ingest MVP
 *
 * 图片/截图/PDF → 带上下文的 markdown 记忆条目 → QMD 增量索引 → recall 可命中
 *
 * 用法:
 *   node ingest.js <file> [--context "背景说明"] [--title "条目标题"]
 *                         [--no-llm] [--no-index] [--force]
 *   node ingest.js --reindex            # 只触发 QMD 增量索引 + daemon reload
 *   node ingest.js --verify "<query>"   # 只查 recall（/search_fast top-8）
 *
 * 设计文档: ~/.claude-brain/v5/DESIGN.md
 * 红线: 只走 full_scan.py incremental（append-only 单一写入者），绝不 rebuild。
 *       零 npm 依赖，零改 v4 文件。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

// ── 路径常量 ────────────────────────────────────────────
const HOME = os.homedir();
const V5_DIR = path.join(HOME, '.claude-brain', 'v5');
const SCRIPTS_DIR = path.join(V5_DIR, 'scripts');
const INGESTED_DIR = path.join(V5_DIR, 'ingested');
const ASSETS_DIR = path.join(INGESTED_DIR, 'assets');
// 刻意命名 *.cache.json —— 撞 full_scan 的排除 regex，ledger 自己不进索引
const LEDGER_PATH = path.join(INGESTED_DIR, 'ledger.cache.json');

// 部署时通过环境变量覆盖，或改成你自己安装的位置
const QMD_VENV_PY = process.env.QMD_VENV_PY || path.join(HOME, '.qmd-venv', 'bin', 'python');
const FULL_SCAN_PY = process.env.QMD_FULL_SCAN || path.join(HOME, '.claude-brain', 'qmd', 'full_scan.py');
const DAEMON_BASE = process.env.QMD_DAEMON_URL || 'http://127.0.0.1:18765';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'; // 默认走 $PATH

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp']);
const NEEDS_CONVERT = new Set(['.heic', '.tiff', '.bmp']); // claude Read 不认 → sips 转 png
const MAX_ASSET_COPY_BYTES = 20 * 1024 * 1024; // >20MB 不拷副本
const PDF_MAX_CHARS = 200000;
const PDF_TEXT_LAYER_MIN_CHARS = 50; // 低于此 = 扫描件，降级
const CLAUDE_TIMEOUT_MS = 150000;
const OCR_TIMEOUT_MS = 120000;

// ── 小工具（自包含，不 require v4 的 util.js，保持 v5 独立）──
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function writeFileAtomic(p, content) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    iso: d.toISOString(),
    file: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`,
    readable: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]}）`,
  };
}

function slugify(s, maxLen = 40) {
  const slug = s
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w一-鿿-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'untitled';
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); }
  catch { return { entries: {} }; }
}

function saveLedger(ledger) {
  writeFileAtomic(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function curlJson(url, timeoutSec = 10) {
  try {
    const out = execFileSync('curl', ['-sf', '--max-time', String(timeoutSec), url], { encoding: 'utf-8' });
    return JSON.parse(out);
  } catch { return null; }
}

// ── 脱敏（机制坑 §5.3：模式匹配是第三道闸，不是保险箱）────
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/gi,
];

function redactSecrets(text) {
  let redacted = text;
  let hits = 0;
  for (const rx of SECRET_PATTERNS) {
    redacted = redacted.replace(rx, () => { hits++; return '[REDACTED]'; });
  }
  return { text: redacted, hits };
}

// ── OCR 降噪（机制坑：截图 OCR 出大量乱码符号会稀释 chunk 嵌入，淹没真信号）──
// 实测：dense 截图 OCR 出 "‡J›‡" "• he•• A ™1¼" "Ez#У +k#ız" 这类垃圾行，
// 和干净文字混进同一 chunk → 嵌入向量被噪声拉浑 → recall 命不中。
// 策略：丢掉"信息字符占比过低"的行（CJK/拉丁字母/数字 < 40% 视为噪声），
//       但保留这些行里能抠出的英文/中文词片段（OCR 噪声里常夹着真品牌名/报错串）。
function isMeaningfulChar(ch) {
  return /[一-鿿A-Za-z0-9]/.test(ch);
}

function cleanOcrLines(rawText) {
  const kept = [];
  const dropped = [];
  for (const lineRaw of rawText.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    const chars = [...line];
    const meaningful = chars.filter(isMeaningfulChar).length;
    const ratio = meaningful / chars.length;
    // 单字符行（菜单项 "X" "Q"）放过；够长且信息密度够才留整行
    if (chars.length <= 2 || ratio >= 0.4) {
      kept.push(line);
    } else {
      // 噪声行里抠连续 ≥3 的字母/CJK 词片段（救回 "GitHub" "commit" 这种夹在乱码里的真词）
      const frags = line.match(/[一-鿿]{2,}|[A-Za-z]{3,}/g);
      if (frags && frags.length) kept.push(frags.join(' '));
      else dropped.push(line);
    }
  }
  return { text: kept.join('\n'), keptLines: kept.length, droppedLines: dropped.length };
}

// ── 召回锚点（Contextual Retrieval 的本机落地：给 chunk 头部塞一句干净的 situating context）──
// 调研结论：Anthropic Contextual Retrieval 把"这块讲什么"的一句话放 chunk 前 → 召回失败率 -49%。
// v5 的落地：条目正文第一段就是一行自然语言锚点 + 关键实体词，让 chunk 嵌入有干净的"头部信号"，
// 而不是以 "v5_ingest: true type: image source_sha256:..." 这种跨条目雷同的 YAML 样板开头（嵌入会撞车）。
function extractEntities(text, max = 12) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  // 英文词组（≥3 字母）+ 连续中文片段（2-12 字），按出现顺序去重
  const matches = text.match(/[A-Za-z][A-Za-z0-9._-]{2,}|[一-鿿]{2,12}/g) || [];
  for (const m of matches) {
    const key = m.toLowerCase();
    if (seen.has(key)) continue;
    // 跳过纯样板/无信息词
    if (/^(the|and|for|with|this|that|null|true|false|http|https|com|www)$/i.test(m)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

// ── 转译层 ──────────────────────────────────────────────
function runJxa(scriptName, args, timeoutMs) {
  const script = path.join(SCRIPTS_DIR, 'jxa', scriptName);
  try {
    return execFileSync('osascript', ['-l', 'JavaScript', script, ...args], {
      encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (e) {
    return JSON.stringify({ error: `jxa failed: ${e.message.split('\n')[0]}` });
  }
}

function ocrImage(imgPath) {
  const out = runJxa('ocr-image.js', [imgPath], OCR_TIMEOUT_MS);
  if (out.startsWith('{') && out.includes('"error"')) {
    try { return { ok: false, error: JSON.parse(out).error }; } catch { /* 是正文 */ }
  }
  return { ok: true, text: out };
}

function extractPdf(pdfPath) {
  const out = runJxa('pdf-extract.js', [pdfPath, String(PDF_MAX_CHARS)], OCR_TIMEOUT_MS);
  try {
    const obj = JSON.parse(out);
    if (obj.error) return { ok: false, error: obj.error };
    return { ok: true, ...obj };
  } catch (e) {
    return { ok: false, error: `bad pdf-extract output: ${e.message}` };
  }
}

function describeWithClaude(imgPath) {
  // HEIC/TIFF/BMP → 先转临时 png（/tmp 不在 SCAN_ROOTS，无索引污染）
  let feedPath = imgPath;
  const ext = path.extname(imgPath).toLowerCase();
  if (NEEDS_CONVERT.has(ext)) {
    feedPath = path.join(os.tmpdir(), `v5-ingest-${process.pid}.png`);
    try {
      execFileSync('sips', ['-s', 'format', 'png', imgPath, '--out', feedPath],
        { stdio: 'ignore', timeout: 60000 });
    } catch { return { ok: false, error: 'sips convert failed' }; }
  }
  const prompt =
    `用 Read 工具读取图片 ${feedPath} 然后输出一段中文描述作为记忆条目：` +
    `第一行一句话概括这张图是什么；然后写图中关键信息（可见文字、UI元素、数据、布局）尽量具体；` +
    `若有密码/token/密钥等敏感凭证不要逐字转写只标注「含敏感凭证已略」；` +
    `纯文本不要markdown标题不要客套话`;
  const res = spawnSync(CLAUDE_BIN, [
    '-p', '--model', 'haiku', '--allowedTools', 'Read', '--no-session-persistence', prompt,
  ], { encoding: 'utf-8', timeout: CLAUDE_TIMEOUT_MS });
  if (feedPath !== imgPath) { try { fs.unlinkSync(feedPath); } catch { /* noop */ } }
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) {
    return { ok: false, error: `claude -p failed (status ${res.status}): ${(res.stderr || '').slice(0, 200)}` };
  }
  return { ok: true, text: res.stdout.trim() };
}

// ── 条目生成 ────────────────────────────────────────────
// 布局铁律（recall 实测得来）：chunk 的"头部信号"决定召回。
// 所以正文顺序 = ① 标题 ② 一行自然语言锚点 ③ 关键词行 ④ 背景上下文 ⑤ 转译正文 ⑥ 元数据(末尾)。
// frontmatter 样板（v5_ingest/source_sha256/...）跨条目雷同，放末尾，不让它占据 chunk 头污染嵌入。
function buildEntry({ type, sourcePath, hash, assetRel, methods, degraded, title, context, sections, ts, redactedHits, meta, anchor, entities }) {
  const typeLabel = type === 'image' ? '图片/截图' : 'PDF 文档';

  // ② 召回锚点：一句话「这是什么」——是 recall query 真正命中的钩子（Contextual Retrieval 落地）
  const anchorLine = anchor && anchor.trim()
    ? anchor.trim()
    : `这是一份通过 claude-brain v5 多模态 ingest 收录的${typeLabel}记忆。${context ? '背景：' + context : ''}`;

  // ③ 关键词行：把抠出的实体词显式平铺，提升稀疏/语义双重命中率
  const kwLine = entities && entities.length
    ? `**关键词**：${entities.join('、')}`
    : '';

  const ctxBlock = [
    '## 背景上下文',
    `- 时间：${ts.readable}`,
    `- 来源：${sourcePath}（${typeLabel}）`,
    `- 用户补充：${context || '（无）'}`,
    ...(redactedHits > 0 ? [`- 脱敏：检测到 ${redactedHits} 处疑似凭证，已替换为 [REDACTED]`] : []),
  ].join('\n');

  // ⑥ 元数据放末尾（不再用 frontmatter 顶头）。仍保留 v5_ingest 机器可读标记。
  const metaBlock = [
    '---',
    '## 元数据',
    '```yaml',
    'v5_ingest: true',
    `type: ${type}`,
    `source_path: ${sourcePath}`,
    `source_sha256: ${hash}`,
    `asset: ${assetRel || 'null'}`,
    `ingested_at: ${ts.iso}`,
    `methods: [${methods.join(', ')}]`,
    `degraded: ${degraded}`,
    ...(meta || []),
    '```',
  ].join('\n');

  return [
    `# ${title}`,
    '',
    anchorLine,
    '',
    ...(kwLine ? [kwLine, ''] : []),
    ctxBlock,
    '',
    ...sections,
    '',
    metaBlock,
    '',
  ].join('\n');
}

// ── 索引 + 验证 ─────────────────────────────────────────
function daemonHealth() {
  return curlJson(`${DAEMON_BASE}/health`, 5);
}

function runIncrementalIndex() {
  console.log('[index] 触发 QMD 增量扫描（官方单一写入者入口，append-only）...');
  const res = spawnSync(QMD_VENV_PY, [FULL_SCAN_PY, 'incremental'], {
    encoding: 'utf-8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.stderr) {
    const tail = res.stderr.trim().split('\n').slice(-6).join('\n');
    console.log(`[index] full_scan 日志（尾部）:\n${tail}`);
  }
  if (res.status !== 0) {
    console.error(`[index] ✗ full_scan 退出码 ${res.status}`);
    return null;
  }
  // 坑：full_scan 用 json.dumps(indent=2) 输出**多行** pretty JSON 到 stdout，
  // 不能只取最后一行（那是 "}"）。抓从第一个 "{" 到末尾的整块解析。
  let stats = null;
  try {
    const out = (res.stdout || '').trim();
    const start = out.indexOf('{');
    if (start >= 0) stats = JSON.parse(out.slice(start));
  } catch (e) { console.error(`[index] ⚠ stats 解析失败（不影响入索引）: ${e.message}`); }
  // stats 解析失败不等于入索引失败 —— 返回一个兜底对象让流程继续到 reload + verify
  if (!stats) stats = { chunks_new: null, total_chunks: null, _stats_parse: 'failed' };
  console.log(`[index] ✓ 增量完成: ${JSON.stringify(stats)}`);
  return stats;
}

function reloadDaemon() {
  const r = curlJson(`${DAEMON_BASE}/reload`, 60);
  if (r) console.log(`[reload] ✓ daemon 热重载: ${JSON.stringify(r)}`);
  else console.error('[reload] ✗ daemon /reload 失败 — 新条目要等 daemon 重启才可检索');
  return r;
}

function _hitOf(results, expectPath) {
  if (!expectPath) return null;
  const base = path.basename(expectPath);
  return results.find((r) => r.file === expectPath || r.file.endsWith(base)) || null;
}

function _normResults(rawResults) {
  return (rawResults || []).map((r, i) => ({
    rank: i + 1,
    file: r.file_path || r.source || r.file || '',
    score: r.score,
    preview: (r.text || '').replace(/\n/g, ' ').slice(0, 80),
  }));
}

// recall 验证：L2 (/search_fast) 先试；命中即止。L2 miss 再走 L3 (/search rerank=1)——
// 这是 brain-memory-qmd.py search 真实走的召回路径，L3 命中 = recall 真的可用。
function verifyRecall(query, expectPath, topK = 10) {
  // L2：快速嵌入召回
  const l2 = curlJson(`${DAEMON_BASE}/search_fast?query=${encodeURIComponent(query)}&top_k=${topK}`, 60);
  const l2Results = _normResults(l2 && l2.results);
  const l2Hit = _hitOf(l2Results, expectPath);
  if (l2Hit) {
    return { hit: true, path: 'L2-fast', hitRank: l2Hit.rank, results: l2Results };
  }

  // L3：reranker 精排（慢但准，真实 recall 路径）
  console.log('[verify] L2 未命中，走 L3 reranker 精排（~30-60s）...');
  const l3 = curlJson(`${DAEMON_BASE}/search?query=${encodeURIComponent(query)}&top_k=${topK}&rerank=1`, 120);
  const l3Results = _normResults(l3 && l3.results);
  const l3Hit = _hitOf(l3Results, expectPath);
  return {
    hit: !!l3Hit,
    path: l3Hit ? 'L3-rerank' : 'miss',
    hitRank: l3Hit ? l3Hit.rank : null,
    results: l3Hit ? l3Results : l2Results, // 命中给命中那层结果，否则给 L2 供诊断
  };
}

// ── 主流程 ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--context' || a === '--title' || a === '--verify') args[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  // 独立模式: --reindex / --verify
  if (args.reindex) {
    const health = daemonHealth();
    if (!health) { console.error('[abort] daemon 离线 — 增量会本地加载 4.27G 模型（OOM 教训），拒跑'); process.exit(1); }
    const stats = runIncrementalIndex();
    if (stats) reloadDaemon();
    process.exit(stats ? 0 : 1);
  }
  if (args.verify) {
    // 独立诊断：直接走 L3 reranker（真实召回路径），打印 top-10 供人眼判断条目是否能召回
    console.log(`[verify] L3 reranker 召回（真实路径，~30-60s）: "${String(args.verify).slice(0, 80)}"`);
    const data = curlJson(
      `${DAEMON_BASE}/search?query=${encodeURIComponent(args.verify)}&top_k=10&rerank=1`, 120);
    const results = _normResults(data && data.results);
    for (const r of results) {
      const tag = r.file.includes('/v5/ingested/') ? '  <== v5 ingested 条目' : '';
      console.log(`  #${r.rank} [${typeof r.score === 'number' ? r.score.toFixed(3) : r.score}] ${path.basename(r.file)}${tag}`);
    }
    process.exit(0);
  }

  const input = args._[0];
  if (!input) {
    console.error('用法: node ingest.js <image|pdf> [--context "..."] [--title "..."] [--no-llm] [--no-index] [--force]');
    process.exit(1);
  }
  const absInput = path.resolve(input);
  if (!fs.existsSync(absInput)) { console.error(`✗ 文件不存在: ${absInput}`); process.exit(1); }

  const ext = path.extname(absInput).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const isPdf = ext === '.pdf';
  if (!isImage && !isPdf) {
    console.error(`✗ 不支持的类型 ${ext}（v5 MVP 只收图片/PDF，视频音频是 v5.1+ 边界）`);
    process.exit(1);
  }

  // ① 去重
  const hash = sha256File(absInput);
  const hash8 = hash.slice(0, 8);
  const ledger = loadLedger();
  if (ledger.entries[hash] && !args.force) {
    console.log(`[dedup] 该文件已 ingest 过（${ledger.entries[hash].entry_file}），幂等跳过。--force 可强制重做`);
    process.exit(0);
  }

  const ts = nowStamp();
  const type = isImage ? 'image' : 'pdf';
  const title = args.title || `${path.basename(absInput)}（${type === 'image' ? '截图/图片' : 'PDF'}，${ts.readable}）`;
  console.log(`[ingest] ${type}: ${absInput} (sha256 ${hash8})`);

  // ② 转译
  const methods = [];
  const sections = [];
  let degraded = false;
  let totalRedacted = 0;
  const meta = [];
  let anchor = null;          // ② 召回锚点的来源（优先 AI 描述首句）
  let cleanedForEntities = ''; // 给 extractEntities 喂的干净文本（AI 描述 + 降噪 OCR）

  if (isImage) {
    // 副路径：Vision OCR（必跑，免费逐字）→ 降噪后再入条目
    console.log('[transcribe] Vision OCR ...');
    const ocr = ocrImage(absInput);
    if (ocr.ok && ocr.text) {
      const cleaned = cleanOcrLines(ocr.text);
      const { text, hits } = redactSecrets(cleaned.text);
      totalRedacted += hits;
      methods.push('vision-ocr');
      cleanedForEntities += '\n' + text;
      sections.push(
        `## 图中可见文字（macOS Vision OCR 逐字，已降噪：留 ${cleaned.keptLines} 行 / 丢 ${cleaned.droppedLines} 行乱码）`,
        '', text, '');
      console.log(`[transcribe] ✓ OCR 降噪后 ${cleaned.keptLines} 行（丢 ${cleaned.droppedLines} 行乱码）`);
    } else {
      console.error(`[transcribe] ✗ OCR 失败: ${ocr.error || 'empty'}`);
    }

    // 主路径：claude -p Haiku 语义描述（--no-llm 可关）—— 描述首句是最干净的召回锚点来源
    if (!args['no-llm']) {
      console.log('[transcribe] claude -p haiku 看图（~40s）...');
      const desc = describeWithClaude(absInput);
      if (desc.ok) {
        const { text, hits } = redactSecrets(desc.text);
        totalRedacted += hits;
        methods.push('claude-haiku');
        cleanedForEntities = text + '\n' + cleanedForEntities; // AI 描述优先权重
        anchor = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || null; // 描述第一句作锚点
        sections.unshift('## 内容描述（claude haiku 看图，可能有误读——逐字事实以 OCR 段为准）', '', text, '');
        console.log('[transcribe] ✓ haiku 描述完成');
      } else {
        console.error(`[transcribe] ✗ claude 失败，降级 OCR-only: ${desc.error}`);
        degraded = true;
      }
    } else {
      console.log('[transcribe] --no-llm，跳过 claude 描述');
    }

    if (methods.length === 0) {
      degraded = true;
      sections.push('## 转译失败', '', '所有转译路径失败，仅存元数据。原图见 asset 副本。', '');
    }
  } else {
    // PDF：PDFKit 文本层
    console.log('[transcribe] PDFKit 文本层提取 ...');
    const pdf = extractPdf(absInput);
    if (!pdf.ok) {
      console.error(`[transcribe] ✗ PDF 提取失败: ${pdf.error}`);
      degraded = true;
      sections.push('## 转译失败', '', `PDFKit 提取失败：${pdf.error}`, '');
    } else if (pdf.chars < PDF_TEXT_LAYER_MIN_CHARS) {
      // 扫描件：v5 MVP 边界（DESIGN.md §7）
      degraded = true;
      meta.push(`pdf_pages: ${pdf.pages}`);
      sections.push(
        '## 扫描件 PDF（无文本层）', '',
        `共 ${pdf.pages} 页，文本层仅 ${pdf.chars} 字符 → 判定为扫描件。`,
        'OCR 渲页转写是 v5.1 边界（见 DESIGN.md §7），本条目仅存元数据供文件名/上下文检索。', '');
      console.log(`[transcribe] ⚠ 扫描件（文本层 ${pdf.chars} 字符），降级条目`);
    } else {
      const { text, hits } = redactSecrets(pdf.text);
      totalRedacted += hits;
      methods.push('pdfkit-text');
      meta.push(`pdf_pages: ${pdf.pages}`);
      cleanedForEntities = text.slice(0, 4000); // 实体词从正文前段抠（足够代表）
      anchor = `一份 ${pdf.pages} 页的 PDF 文档（${pdf.chars} 字符文本层）。`
        + (text.replace(/\s+/g, ' ').trim().slice(0, 80) || '');
      sections.push(
        `## 文本内容（PDFKit 文本层，${pdf.pages} 页 ${pdf.chars} 字符${pdf.truncated ? `，截断至 ${PDF_MAX_CHARS}` : ''}）`,
        '', text, '');
      console.log(`[transcribe] ✓ ${pdf.pages} 页 ${pdf.chars} 字符${pdf.truncated ? '（截断）' : ''}`);
    }
  }

  // ③ 抠关键实体词（喂给条目头部的关键词行，提升命中）
  const entities = extractEntities((args.context ? args.context + '\n' : '') + cleanedForEntities, 12);

  // ④ asset 副本（≤20MB；二进制扩展名 QMD 天然跳过，无索引污染）
  let assetRel = null;
  const srcSize = fs.statSync(absInput).size;
  if (srcSize <= MAX_ASSET_COPY_BYTES) {
    const assetName = `${hash8}${ext}`;
    fs.copyFileSync(absInput, path.join(ASSETS_DIR, assetName));
    assetRel = `assets/${assetName}`;
  } else {
    console.log(`[asset] 源文件 ${(srcSize / 1048576).toFixed(1)}MB > 20MB，不拷副本（只留 source_path 引用）`);
  }

  // 写条目（一经写入不可变 — DESIGN.md §5.2）
  const entryName = `${ts.file}-${slugify(args.title || path.basename(absInput))}-${hash8}.md`;
  const entryPath = path.join(INGESTED_DIR, entryName);
  const content = buildEntry({
    type, sourcePath: absInput, hash, assetRel, methods, degraded,
    title, context: args.context, sections, ts, redactedHits: totalRedacted, meta,
    anchor, entities,
  });
  writeFileAtomic(entryPath, content);
  console.log(`[entry] ✓ ${entryPath}`);

  // 更新 ledger
  ledger.entries[hash] = {
    entry_file: entryName, source_path: absInput, type,
    ingested_at: ts.iso, methods, degraded,
  };
  saveLedger(ledger);

  // ⑤ 入索引
  if (args['no-index']) {
    console.log('[index] --no-index，跳过。稍后跑: node ingest.js --reindex');
    process.exit(0);
  }
  const health = daemonHealth();
  if (!health) {
    console.error('[index] ⚠ daemon 离线 — 跳过入索引（防本地双份模型 OOM）。daemon 回来后跑: node ingest.js --reindex');
    process.exit(0);
  }
  const baseline = health.chunks;
  console.log(`[index] daemon 在线，基线 ${baseline} chunks`);
  const stats = runIncrementalIndex();
  if (!stats) process.exit(1);
  reloadDaemon();

  // ⑥ 验证 recall —— 查询贴近真实"我记得那张图里有 X"的检索，用锚点 + 关键词组合
  const query = [args.context, anchor, ...(entities || []).slice(0, 6)]
    .filter(Boolean).join(' ').slice(0, 160) || title;
  console.log(`[verify] recall 查询: "${query.slice(0, 80)}"`);
  const v = verifyRecall(query, entryPath);
  if (v.hit) {
    console.log(`[verify] ✓ recall 命中（${v.path}）！本条目排名 #${v.hitRank}/top-${v.results.length}`);
  } else {
    console.log('[verify] ✗ L2+L3 均未命中本条目（top 结果供诊断）：');
  }
  for (const r of v.results.slice(0, 6)) {
    const mark = (r.file === entryPath || r.file.endsWith(path.basename(entryPath))) ? '  <== 本条目' : '';
    console.log(`  #${r.rank} [${typeof r.score === 'number' ? r.score.toFixed(3) : r.score}] ${path.basename(r.file)}${mark}`);
  }

  console.log('\n' + JSON.stringify({
    entry: entryPath, methods, degraded, entities,
    chunks_new: stats.chunks_new, total_chunks: stats.total_chunks,
    recall_hit: v.hit, recall_path: v.path, recall_rank: v.hitRank,
  }));
}

main();
