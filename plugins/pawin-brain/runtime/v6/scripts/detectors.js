// detectors.js — claude-brain v6 屎山红灯 · 纯检测函数库（加固版 v6.0.1）
//
// 设计哲学：红灯不是 linter 报错清单，是「把延迟的维护代价翻译成当场的即时信号」。
// 每条红灯只抓「高信号 + 低误报」的屎山迹象，命中就逼主脑当场做一个有意识的二选一决策
// ——治的是「图省事」这个动机，不是凑指标。所以文案一律「① 现在改 ② 写下为什么不改」，
// 让搪塞的成本高于照做。
//
// 约定：
//   每个检测器 = 纯函数 (ctx, cfg) => Finding | null   —— 零副作用、零依赖、可单测
//   ctx     = { content, lines, lineCount, filePath, ext, isTest }
//   Finding = { id, severity:'high'|'mid'|'low', hard:boolean, title, prompt }
//             hard 恒为 false —— PostToolUse 的 decision:block 不回滚文件且会触发
//             「block→重试→再block」死循环，所以本层一律软注入。硬拦留给未来 PreToolUse。
//
// 加固审查（2026-06-17 六维 workflow）落实：密钥降误报+去硬拦 / 补 longFunction /
// deadCode 豁免 JSDoc / debugLeftover 阈值化。dirtyNaming/deepNesting/AST 仍留 v6.1（误报或过重）。

'use strict';

// 一行里出现这些 = 像代码而非自然语言（区分「注释掉的代码」与「文档注释」）
const CODE_HINT = /[;{}()=]|=>|->|::|\bdef\b|\bfn\b|\bfunc\b|\bclass\b|\breturn\b|\bif\b|\bfor\b|\bconst\b|\blet\b|\bvar\b|\bimport\b/;
// JSDoc/文档 tag —— 含这些的注释是文档不是死代码，豁免
const DOC_TAG = /@example|@param|@returns?|@throws|@deprecated|@see|@code/;
const LINE_COMMENT = /^\s*(\/\/|#|--)\s?(.*)$/;

function clamp(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── 1. 文件过长 ── 语言无关、最稳的屎山信号
function fileTooLong(ctx, cfg) {
  const { lineCount } = ctx;
  const hardMax = (cfg.file_too_long && cfg.file_too_long.hard_max) || 800;
  const warn = (cfg.file_too_long && cfg.file_too_long.warn) || 500;
  if (lineCount > hardMax) {
    return {
      id: 'file_too_long', severity: 'high', hard: false,
      title: `这文件 ${lineCount} 行了（过了 ${hardMax} 行上限）`,
      prompt: `${lineCount} 行。两条路选一条：① 现在拆开（先说拆成哪几块）② 不拆（写一句为什么这文件非这么大不可）。别默默划过去 ——「多个小文件 > 一个大文件」是你自己定的铁律。`,
    };
  }
  if (lineCount > warn) {
    return {
      id: 'file_too_long', severity: 'mid', hard: false,
      title: `这文件 ${lineCount} 行（黄灯，接近上限）`,
      prompt: `${lineCount} 行，开始胖了。它还会继续长吗？要长就趁现在好拆的时候分块，别等到 ${hardMax} 行积重难返。`,
    };
  }
  return null;
}

// ── 2. 单个超长代码块 ── 「往一个函数里堆」是图省事最典型的形态
//    语言无关近似：以空行/注释行为边界切「连续代码块」，块内排除数据/import 行后仍超阈值 → 报。
//    不做 AST（过重、违背 hook 轻量原则），这个近似已能抓住大部分巨型函数体。
function longFunction(ctx, cfg) {
  const { lines } = ctx;
  const threshold = (cfg && cfg.long_block_lines) || 80;
  const dataish = /^\s*['"]?[\w.-]+['"]?\s*[:=]\s*.+,?\s*$|^\s*(import|from|use|require|#include|export)\b|^\s*['"][^'"]*['"],?\s*$/;

  let run = 0, dataCount = 0, startLine = 0;
  let best = { run: 0, start: 0 };
  const flush = () => {
    // 块够长 且 其中「真代码行（非数据/import）」占主体 → 像一个没拆的大函数体
    if (run >= threshold && (run - dataCount) >= threshold * 0.6 && run > best.run) {
      best = { run, start: startLine };
    }
    run = 0; dataCount = 0;
  };

  lines.forEach((ln, i) => {
    if (ln.trim() === '' || LINE_COMMENT.test(ln) || /^\s*\*/.test(ln)) { flush(); return; }
    if (run === 0) startLine = i + 1;
    run++;
    if (dataish.test(ln)) dataCount++;
  });
  flush();

  if (best.run >= threshold) {
    return {
      id: 'long_function', severity: 'high', hard: false,
      title: `第 ${best.start} 行起 ${best.run} 行代码一口气堆下来没断开`,
      prompt: `第 ${best.start} 行起 ${best.run} 行代码连着堆没拆。「往一个函数里堆」是图省事最典型的样子。它在做几件事？两件以上就该拆成小函数。① 现在拆 ② 写一句为什么它必须这么长。`,
    };
  }
  return null;
}

// ── 3. 大段注释掉的死代码 ── 「舍不得删」的功能恋物癖（豁免头部 banner + JSDoc 文档）
function deadCode(ctx, cfg) {
  const { lines } = ctx;
  const minRun = (cfg && cfg.dead_code_min_lines) || 6;
  const headerSkip = (cfg && cfg.dead_code_header_skip) || 10;

  let run = 0, codeish = 0, docish = 0, startLine = 0;
  let best = { run: 0, codeish: 0, start: 0 };
  const flush = () => {
    // 块内一半以上像代码、且不像文档(@tag) → 判为注释掉的死代码
    if (run >= minRun && codeish >= Math.ceil(run * 0.5) && docish === 0 && run > best.run) {
      best = { run, codeish, start: startLine };
    }
    run = 0; codeish = 0; docish = 0;
  };

  lines.forEach((ln, i) => {
    const m = ln.match(LINE_COMMENT);
    if (m) {
      if (run === 0) startLine = i + 1;
      run++;
      const body = m[2] || '';
      if (CODE_HINT.test(body)) codeish++;
      if (DOC_TAG.test(body)) docish++;
    } else {
      flush();
    }
  });
  flush();

  if (best.run >= minRun && best.start > headerSkip) {
    return {
      id: 'dead_code', severity: 'mid', hard: false,
      title: `第 ${best.start} 行起约 ${best.run} 行被注释掉的代码`,
      prompt: `第 ${best.start} 行起约 ${best.run} 行注释掉的代码。git 记得住一切 —— 留着的死代码只让后面的人不敢碰它周围。① 删掉 ② 写一句为什么非留不可。`,
    };
  }
  return null;
}

// ── 4. TODO/FIXME 堆积 ── 延迟代价显性化、却从不回来还
function todoPileup(ctx, cfg) {
  const { content } = ctx;
  const threshold = (cfg && cfg.todo_pileup_threshold) || 5;
  const re = /\b(TODO|FIXME|HACK|XXX)\b|待补|待办|先写死|暂时这样/g;
  const matches = content.match(re) || [];
  if (matches.length >= threshold) {
    return {
      id: 'todo_pileup', severity: 'low', hard: false,
      title: `${matches.length} 处 TODO/FIXME 堆在这一个文件里`,
      prompt: `${matches.length} 个 TODO/FIXME。「以后再清」的以后通常不会来。挑一个现在能做掉的做掉，剩下的至少别再往上加。`,
    };
  }
  return null;
}

// ── 5. 调试输出残留 ── 单条可能合法，成堆(≥阈值)才像调试残留；测试文件放宽
function debugLeftover(ctx, cfg) {
  if (ctx.isTest) return null;
  const { lines } = ctx;
  const min = (cfg && cfg.debug_leftover_min) || 2;
  const re = /\bconsole\.(log|debug)\b|\bdebugger\b|\bdbg!|\bvar_dump\s*\(/;
  const skipComment = /^\s*(\/\/|#|\*|--)/;
  const hits = [];
  lines.forEach((ln, i) => {
    if (re.test(ln) && !skipComment.test(ln)) hits.push(i + 1);
  });
  if (hits.length >= min) {
    return {
      id: 'debug_leftover', severity: 'low', hard: false,
      title: `${hits.length} 处调试输出残留（行 ${clamp(hits.join(','), 30)}）`,
      prompt: `生产代码里 ${hits.length} 处 console.log / debugger。交付前清掉，或换成正经日志 —— 别让调试痕迹漏进交付。`,
    };
  }
  return null;
}

// ── 6. 硬编码密钥 ── 软注入（不硬拦，避开 PostToolUse block 死循环）；强特征直报，弱特征要熵+排占位符
const PLACEHOLDER = /your[-_]|xxx+|placeholder|example|changeme|<[^>]+>|\$\{|process\.env|os\.environ|REPLACE|dummy|sample|test[-_]?key|\.\.\./i;

function hasEntropy(s) {
  // 真密钥多是混合大小写+数字的长串；纯单词(如 "password")或纯小写不算
  return s.length >= 8 && /[a-z]/.test(s) && /[A-Z0-9]/.test(s);
}

function secretFinding(line, name) {
  return {
    id: 'hardcoded_secret', severity: 'high', hard: false,
    title: `第 ${line} 行疑似${name}`,
    prompt: `🔴 第 ${line} 行像${name}。密钥进代码 = 进 git 历史，删都删不干净。二选一做掉：① 真密钥 → 现在就移到环境变量 / 密钥管理 ② 占位或示例 → 这条划过。别留着真密钥往下写。`,
  };
}

function hardcodedSecret(ctx, cfg) {
  const { lines } = ctx;
  const strong = [
    { re: /\bsk-[A-Za-z0-9]{20,}/, name: '类 sk- API 密钥' },
    { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS Access Key' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: '私钥 PEM 块' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, name: 'GitHub token' },
  ];
  const weak = /(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]([^'"\s]{8,})['"]/i;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const p of strong) {
      if (p.re.test(ln)) return secretFinding(i + 1, p.name); // 强特征：占位词也照报
    }
    const m = ln.match(weak);
    if (m && !PLACEHOLDER.test(ln) && hasEntropy(m[2] || '')) {
      return secretFinding(i + 1, '硬编码凭据字面量');
    }
  }
  return null;
}

// hardcodedSecret 放第一 —— 最该被先看到的高危项
const DETECTORS = [hardcodedSecret, fileTooLong, longFunction, deadCode, todoPileup, debugLeftover];

function runAll(ctx, cfg) {
  return DETECTORS
    .map((fn) => { try { return fn(ctx, cfg || {}); } catch { return null; } })
    .filter(Boolean);
}

module.exports = {
  runAll, DETECTORS,
  fileTooLong, longFunction, deadCode, todoPileup, debugLeftover, hardcodedSecret,
};
