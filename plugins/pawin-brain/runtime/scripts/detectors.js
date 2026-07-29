// detectors.js — Claude Brain · Shitcode Red-Light · pure detector library
//
// Philosophy: a red light is NOT a linter error list. It "translates the
// DELAYED cost of maintenance into an IMMEDIATE signal, right at the moment
// you write the code." Each detector only catches HIGH-signal + LOW-false-positive
// shitcode symptoms, and on a hit it forces the model to make a conscious
// binary choice — it treats the *motivation* ("just cut a corner"), not a metric.
// That's why every message ends with: "(1) fix it now  (2) write one line on
// why you're not" — making it more expensive to hand-wave than to just do it.
//
// Contract:
//   each detector = pure function (ctx, cfg) => Finding | null  — zero side effects,
//                   zero deps, unit-testable
//   ctx     = { content, lines, lineCount, filePath, ext, isTest }
//   Finding = { id, severity:'high'|'mid'|'low', hard:boolean, title, prompt }
//             hard is ALWAYS false — a PostToolUse decision:block does NOT roll back
//             the written file and triggers a "block → retry → block" infinite loop,
//             so this layer is always a soft injection. Hard blocking is left to a
//             future PreToolUse hook (which fires BEFORE the write).

'use strict';

// A line containing these looks like CODE rather than natural language
// (used to tell "commented-out code" apart from "doc comments").
const CODE_HINT = /[;{}()=]|=>|->|::|\bdef\b|\bfn\b|\bfunc\b|\bclass\b|\breturn\b|\bif\b|\bfor\b|\bconst\b|\blet\b|\bvar\b|\bimport\b/;
// JSDoc / doc tags — a comment with these is documentation, not dead code: exempt.
const DOC_TAG = /@example|@param|@returns?|@throws|@deprecated|@see|@code/;
const LINE_COMMENT = /^\s*(\/\/|#|--)\s?(.*)$/;

function clamp(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── 1. File too long ── language-agnostic, the most reliable shitcode signal
function fileTooLong(ctx, cfg) {
  const { lineCount } = ctx;
  const hardMax = (cfg.file_too_long && cfg.file_too_long.hard_max) || 800;
  const warn = (cfg.file_too_long && cfg.file_too_long.warn) || 500;
  if (lineCount > hardMax) {
    return {
      id: 'file_too_long', severity: 'high', hard: false,
      title: `This file is now ${lineCount} lines (over the ${hardMax}-line limit)`,
      prompt: `${lineCount} lines. Pick one: (1) split it now — say which pieces; (2) don't — write one line on why this file has to be this big. Don't just scroll past — "many small files > one big file" is a rule worth keeping.`,
    };
  }
  if (lineCount > warn) {
    return {
      id: 'file_too_long', severity: 'mid', hard: false,
      title: `This file is ${lineCount} lines (yellow flag, approaching the limit)`,
      prompt: `${lineCount} lines, getting chunky. Will it keep growing? If so, split it now while it's still easy — don't wait until ${hardMax} lines when it's a swamp.`,
    };
  }
  return null;
}

// ── 2. One oversized code block ── "pile it into one function" is the most classic shortcut
//    Language-agnostic approximation: split into "contiguous code blocks" by blank/comment
//    lines; if a block exceeds the threshold after excluding data/import lines, flag it.
//    No AST (too heavy, violates the "keep the hook light" principle); this approximation
//    already catches most giant function bodies.
function longFunction(ctx, cfg) {
  const { lines } = ctx;
  const threshold = (cfg && cfg.long_block_lines) || 80;
  const dataish = /^\s*['"]?[\w.-]+['"]?\s*[:=]\s*.+,?\s*$|^\s*(import|from|use|require|#include|export)\b|^\s*['"][^'"]*['"],?\s*$/;

  let run = 0, dataCount = 0, startLine = 0;
  let best = { run: 0, start: 0 };
  const flush = () => {
    // block long enough AND mostly "real code" (not data/import) → looks like an un-split big function body
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
      title: `${best.run} lines of code piled up from line ${best.start} with no break`,
      prompt: `${best.run} lines stacked from line ${best.start} with no split. "Pile it into one function" is the most classic shortcut. How many things is it doing? More than two → split into smaller functions. (1) split now (2) write one line on why it must be this long.`,
    };
  }
  return null;
}

// ── 3. Large blocks of commented-out dead code ── the "can't bear to delete it" hoarding
//    (exempts the header banner + JSDoc docs)
function deadCode(ctx, cfg) {
  const { lines } = ctx;
  const minRun = (cfg && cfg.dead_code_min_lines) || 6;
  const headerSkip = (cfg && cfg.dead_code_header_skip) || 10;

  let run = 0, codeish = 0, docish = 0, startLine = 0;
  let best = { run: 0, codeish: 0, start: 0 };
  const flush = () => {
    // over half the block looks like code AND not like docs (@tag) → commented-out dead code
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
      title: `~${best.run} lines of commented-out code from line ${best.start}`,
      prompt: `~${best.run} lines of commented-out code from line ${best.start}. Git remembers everything — dead code left behind only makes the next person afraid to touch what's around it. (1) delete it (2) write one line on why it must stay.`,
    };
  }
  return null;
}

// ── 4. TODO/FIXME pileup ── delayed cost made visible, that never comes back to be paid
function todoPileup(ctx, cfg) {
  const { content } = ctx;
  const threshold = (cfg && cfg.todo_pileup_threshold) || 5;
  // English markers + a few common CJK ones (multilingual-friendly)
  const re = /\b(TODO|FIXME|HACK|XXX)\b|待补|待办|先写死|暂时这样/g;
  const matches = content.match(re) || [];
  if (matches.length >= threshold) {
    return {
      id: 'todo_pileup', severity: 'low', hard: false,
      title: `${matches.length} TODO/FIXME markers piled in this one file`,
      prompt: `${matches.length} TODOs/FIXMEs. "Later" usually never comes. Knock out one you can do right now, and at least stop adding more.`,
    };
  }
  return null;
}

// ── 5. Leftover debug output ── one may be legit; a pile (≥ threshold) looks like debug residue; test files relaxed
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
      title: `${hits.length} leftover debug outputs (lines ${clamp(hits.join(','), 30)})`,
      prompt: `${hits.length} console.log / debugger in production code. Clear them before shipping, or switch to a real logger — don't let debug traces leak into delivery.`,
    };
  }
  return null;
}

// ── 6. Hardcoded secret ── soft injection (no hard block — avoids the PostToolUse block loop);
//    strong patterns reported directly, weak patterns require entropy + exclude placeholders
const PLACEHOLDER = /your[-_]|xxx+|placeholder|example|changeme|<[^>]+>|\$\{|process\.env|os\.environ|REPLACE|dummy|sample|test[-_]?key|\.\.\./i;

function hasEntropy(s) {
  // real secrets are usually long mixed-case + digit strings; plain words ("password") or all-lowercase don't count
  return s.length >= 8 && /[a-z]/.test(s) && /[A-Z0-9]/.test(s);
}

function secretFinding(line, name) {
  return {
    id: 'hardcoded_secret', severity: 'high', hard: false,
    title: `Line ${line} looks like a ${name}`,
    prompt: `🔴 Line ${line} looks like a ${name}. A secret in code = a secret in git history, impossible to fully scrub. Pick one: (1) real secret → move it to env vars / a secret manager now; (2) placeholder or example → skip this. Don't keep a real secret and just code on.`,
  };
}

function hardcodedSecret(ctx, cfg) {
  const { lines } = ctx;
  const strong = [
    { re: /\bsk-[A-Za-z0-9]{20,}/, name: 'sk- style API key' },
    { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS Access Key' },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: 'private key PEM block' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, name: 'GitHub token' },
  ];
  const weak = /(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]([^'"\s]{8,})['"]/i;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const p of strong) {
      if (p.re.test(ln)) return secretFinding(i + 1, p.name); // strong pattern: report even with placeholder words
    }
    const m = ln.match(weak);
    if (m && !PLACEHOLDER.test(ln) && hasEntropy(m[2] || '')) {
      return secretFinding(i + 1, 'hardcoded credential literal');
    }
  }
  return null;
}

// hardcodedSecret first — the highest-risk item should be seen first
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
