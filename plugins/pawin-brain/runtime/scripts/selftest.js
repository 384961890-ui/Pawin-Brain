#!/usr/bin/env node
// selftest.js — Claude Brain · Shitcode Red-Light regression suite.
// Generates fixtures → runs smell-check.js end-to-end → asserts.
// Driven by Node (not shell) to avoid multi-line parsing issues.
// Temporarily flips enabled:true for the test run, then restores the original.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(os.tmpdir(), 'brain-selftest');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const BRAIN = process.env.BRAIN_DIR || path.join(os.homedir(), '.claude-brain');
const HOOK = path.join(__dirname, 'smell-check.js');
const CONFIG = path.join(BRAIN, 'config.json');
const THROTTLE = path.join(BRAIN, 'state/throttle.json');

// Force enabled:true during the test (save original, restore at the end)
const origConfig = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf-8') : '{}';
const testCfg = JSON.parse(origConfig);
testCfg.enabled = true;
fs.mkdirSync(BRAIN, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify(testCfg, null, 2));

function restore() { fs.writeFileSync(CONFIG, origConfig); }

// ── fixtures ──
const W = (name, content) => fs.writeFileSync(path.join(DIR, name), content);

W('clean.js', `'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n`);

W('doc.md', `# Title\nProse text, any length — should never be touched by the shitcode check.\n`);

// real secret → soft injection (no longer block)
W('secret_real.js', `const config = {\n  apiKey: "sk-proj-abcdefghij1234567890XYZ",\n};\nmodule.exports = config;\n`);

// placeholder / env → must NOT false-positive
W('secret_placeholder.js', `const a = "your-password-here";\nconst b = process.env.API_KEY;\nconst c = "changeme";\nmodule.exports = { a, b, c };\n`);

// business filename with a _test infix → must NOT be treated as a test; debug_leftover should fire (>=2)
W('latest_test_results.js', `function report() {\n  console.log('a');\n  console.log('b');\n  return 1;\n}\nmodule.exports = { report };\n`);

// JSDoc @example code samples → must NOT be misjudged as dead code
const jsdoc = [`'use strict';`, `// plain file header`];
for (let i = 0; i < 8; i++) jsdoc.push(`// @example const x = foo(${i}); if (x) { bar(x); }`);
jsdoc.push(`function foo(n) { return n + 1; }`, `module.exports = { foo };`);
W('jsdoc.js', jsdoc.join('\n'));

// one oversized code block (>80 contiguous real-code lines) → should trigger long_function
const longfn = [`'use strict';`, `function huge() {`];
for (let i = 1; i <= 100; i++) longfn.push(`  doStep${i}(); validate${i}(); accumulate${i}();`);
longfn.push(`  return true;`, `}`, `module.exports = { huge };`);
W('longfn.js', longfn.join('\n'));

function run(file) {
  try { fs.rmSync(THROTTLE, { force: true }); } catch {}
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(DIR, file) } });
  try {
    return execFileSync('node', [HOOK], { input: payload, encoding: 'utf-8' }).trim();
  } catch (e) {
    return '(execution error: ' + e.message + ')';
  }
}

const cases = [
  ['clean.js', 'silent (empty)', (o) => o === ''],
  ['doc.md', 'gated out (empty)', (o) => o === ''],
  ['secret_real.js', 'real secret → soft inject (additionalContext, not block)', (o) => o.includes('additionalContext') && o.includes('secret') && !o.includes('"decision"')],
  ['secret_placeholder.js', 'placeholder/env → no false positive (empty)', (o) => o === ''],
  ['latest_test_results.js', 'business _test file not treated as test → debug fires', (o) => o.includes('additionalContext') && o.includes('debug')],
  ['jsdoc.js', 'JSDoc @example → not misjudged as dead code (empty)', (o) => o === ''],
  ['longfn.js', 'oversized code block → triggers long_function', (o) => o.includes('additionalContext') && o.includes('no break')],
];

const report = ['# Shitcode Red-Light self-test report', ''];
let pass = 0;
for (const [file, expect, assert] of cases) {
  const out = run(file);
  const ok = assert(out);
  if (ok) pass++;
  report.push(`## ${file} — expect "${expect}" — ${ok ? '✅ PASS' : '❌ FAIL'}`);
  report.push('```');
  report.push(out || '(no output)');
  report.push('```', '');
}
report.unshift(`Result: ${pass}/${cases.length} PASS`, '');

restore();
const reportPath = path.join(BRAIN, 'state/selftest-report.md');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, report.join('\n'));
process.stdout.write(`${pass}/${cases.length} PASS -> ${reportPath}\n`);
