#!/usr/bin/env node
// selftest.js — v6 屎山红灯自测（加固版回归套件）。
// 生成 fixture → 端到端跑 smell-check.js → 断言。用 Node 驱动，绕开 shell 多行解析问题。
// 在一次性 HOME 里跑，不读写用户真实 config/state/report。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v6selftest-'));
const TEST_HOME = path.join(DIR, 'home');
const TEST_BRAIN = path.join(TEST_HOME, '.claude-brain');
const V6 = path.join(TEST_BRAIN, 'v6');
const HOOK = path.join(__dirname, 'smell-check.js');
const CONFIG = path.join(V6, 'config.json');
const THROTTLE = path.join(V6, 'state/throttle.json');

const EXAMPLE = path.join(__dirname, '..', 'config.json.example');
const baseConfig = fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, 'utf-8')
  : '{"enabled": true}';
const testCfg = JSON.parse(baseConfig);
testCfg.enabled = true;
fs.mkdirSync(path.join(V6, 'state'), { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify(testCfg, null, 2), { mode: 0o600 });

// ── fixtures ──
const W = (name, content) => fs.writeFileSync(path.join(DIR, name), content);

W('clean.js', `'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n`);

W('doc.md', `# 标题\n说明文字，多长都不该被屎山检测管。\n`);

// 运行时拼出“密钥形状”的假数据，避免仓库扫描器把测试夹具当成真实凭证。
const syntheticSecret = ['sk', 'proj', 'abcdefghij1234567890XYZ'].join('-');
W('secret_real.js', `const config = {\n  apiKey: "${syntheticSecret}",\n};\nmodule.exports = config;\n`);

// 占位符/env → 不该误报
W('secret_placeholder.js', `const a = "your-password-here";\nconst b = process.env.API_KEY;\nconst c = "changeme";\nmodule.exports = { a, b, c };\n`);

// 业务文件名带 _test 中缀 → 不该被当测试，debug_leftover 应生效(≥2)
W('latest_test_results.js', `function report() {\n  console.log('a');\n  console.log('b');\n  return 1;\n}\nmodule.exports = { report };\n`);

// JSDoc @example 代码示例 → 不该误判成死代码
const jsdoc = [`'use strict';`, `// 普通文件头`];
for (let i = 0; i < 8; i++) jsdoc.push(`// @example const x = foo(${i}); if (x) { bar(x); }`);
jsdoc.push(`function foo(n) { return n + 1; }`, `module.exports = { foo };`);
W('jsdoc.js', jsdoc.join('\n'));

// 单个超长代码块(>80行连续真代码) → 应触发 long_function
const longfn = [`'use strict';`, `function huge() {`];
for (let i = 1; i <= 100; i++) longfn.push(`  doStep${i}(); validate${i}(); accumulate${i}();`);
longfn.push(`  return true;`, `}`, `module.exports = { huge };`);
W('longfn.js', longfn.join('\n'));

function run(file) {
  try { fs.rmSync(THROTTLE, { force: true }); } catch {}
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(DIR, file) } });
  try {
    return execFileSync(process.execPath, [HOOK], {
      input: payload,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: TEST_HOME,
        BRAIN_DIR: TEST_BRAIN,
        CLAUDE_BRAIN_DIR: TEST_BRAIN
      }
    }).trim();
  } catch (e) {
    return '(执行出错: ' + e.message + ')';
  }
}

const cases = [
  ['clean.js', '静默(空)', (o) => o === ''],
  ['doc.md', '门禁跳过(空)', (o) => o === ''],
  ['secret_real.js', '真密钥→软注入(additionalContext, 非block)', (o) => o.includes('additionalContext') && o.includes('密钥') && !o.includes('"decision"')],
  ['secret_placeholder.js', '占位符/env→不误报(空)', (o) => o === ''],
  ['latest_test_results.js', '业务_test文件不被当测试→debug生效', (o) => o.includes('additionalContext') && o.includes('调试输出')],
  ['jsdoc.js', 'JSDoc @example→不误判死代码(空)', (o) => o === ''],
  ['longfn.js', '超长代码块→触发long_function', (o) => o.includes('additionalContext') && o.includes('没断开')],
];

const report = ['# v6 屎山红灯自测报告（加固版回归）', ''];
let pass = 0;
for (const [file, expect, assert] of cases) {
  const out = run(file);
  const ok = assert(out);
  if (ok) pass++;
  report.push(`## ${file} — 期望「${expect}」 — ${ok ? '✅ PASS' : '❌ FAIL'}`);
  report.push('```');
  report.push(out || '(无输出)');
  report.push('```', '');
}
report.unshift(`结果：${pass}/${cases.length} PASS`, '');

const reportPath = path.join(DIR, 'selftest-report.md');
fs.writeFileSync(reportPath, report.join('\n'), { mode: 0o600 });
process.stdout.write(`${pass}/${cases.length} PASS -> ${reportPath}\n`);
