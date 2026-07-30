'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const ROUTER = path.join(ROOT, 'scripts', 'claude-hook-router.js');
const INJECT_CONTEXT = path.join(ROOT, 'scripts', 'inject-context.js');
const BOOTSTRAP = path.join(ROOT, 'plugins', 'pawin-brain', 'scripts', 'bootstrap-runtime.js');

function freshRuntime(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin claude router '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home with spaces');
  const brain = path.join(base, 'brain data with spaces');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_BRAIN_DIR: brain,
    CLAUDE_BRAIN_RUNTIME_DIR: ROOT,
    CLAUDE_BRAIN_HOST: 'claude-code'
  };
  const result = spawnSync(process.execPath, [BOOTSTRAP, '--json'], {
    env,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const configPath = path.join(brain, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.qmd_enabled = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { base, brain, env };
}

function runRouter(mode, payload, env) {
  return spawnSync(process.execPath, [ROUTER, mode], {
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024
  });
}

test('UserPrompt fan-out combines context and protocol while dry-run has no injection writes', t => {
  const { brain, env } = freshRuntime(t);
  const configPath = path.join(brain, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.debug = true;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const lessonsPath = path.join(brain, 'lessons', 'INDEX.json');
  fs.writeFileSync(lessonsPath, JSON.stringify({
    lessons: [{
      id: 'lesson-dry-run',
      title: 'Dry run',
      summary: 'must remain unchanged',
      severity: 'high',
      status: 'confirmed',
      activation_count: 7
    }]
  }), { mode: 0o600 });
  const beforeLessons = fs.readFileSync(lessonsPath, 'utf8');
  const stuckPath = path.join(brain, 'v3', 'stuck-flag.json');
  fs.writeFileSync(stuckPath, JSON.stringify({ stuck: true }), { mode: 0o600 });

  const result = runRouter('user-prompt', {
    session_id: 'dry/run session',
    prompt: '如何优化这个项目下一步的实现',
    cwd: path.join(brain, 'project')
  }, { ...env, BRAIN_DRY_RUN: '1' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.additionalContext, /<brain-context>/);
  assert.match(output.additionalContext, /<honest-loop-protocol>/);
  assert.match(output.additionalContext, /THINK-LOOP/);
  assert.match(output.additionalContext, /IDEA-LOOP/);

  assert.ok(fs.existsSync(stuckPath), 'dry-run consumed stuck flag');
  assert.equal(fs.readFileSync(lessonsPath, 'utf8'), beforeLessons, 'dry-run changed activation');
  assert.ok(!fs.existsSync(path.join(brain, 'last_activity.json')), 'dry-run wrote last activity');
  assert.ok(!fs.existsSync(path.join(brain, 'state', 'activated-dry_run_session.json')));
  assert.ok(!fs.existsSync(path.join(brain, 'v4', 'last-trigger.json')), 'dry-run wrote v4 trigger');
  assert.ok(!fs.existsSync(path.join(brain, 'v2', 'data', 'audit-log.jsonl')), 'dry-run wrote protocol audit');
  assert.ok(!fs.existsSync(path.join(brain, 'logs', 'brain-debug.log')), 'dry-run wrote debug state');
});

test('tool success and failure both reach behavior tracking with normalized event names', t => {
  const { brain, env } = freshRuntime(t);
  const success = runRouter('tool-success', {
    session_id: 'tool-session',
    tool_name: 'Read',
    tool_input: { file_path: __filename }
  }, env);
  assert.equal(success.status, 0, success.stderr);
  const failure = runRouter('tool-failure', {
    session_id: 'tool-session',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' }
  }, env);
  assert.equal(failure.status, 0, failure.stderr);

  const state = JSON.parse(fs.readFileSync(
    path.join(brain, 'state', 'behavior-tool-session.json'),
    'utf8'
  ));
  assert.equal(state.step, 2);
  assert.equal(state.validation_count, 2);
  assert.equal(state.failure_count, 1);
});

test('Stop fan-out uses one payload and always updates STATE after earlier handlers', t => {
  const { base, brain, env } = freshRuntime(t);
  const transcript = path.join(base, 'transcript with spaces.jsonl');
  const userText = '不对 你又在没验证的时候说完成了 重新做';
  const assistantText = '还是不行 我接下来重新检查并修复这个问题 目前这个版本不能稳定安装 因为相关配置没有被正确读取 我会继续处理';
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] }
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] }
    })
  ].join('\n') + '\n');
  const statePath = path.join(brain, 'STATE.md');
  const before = fs.readFileSync(statePath, 'utf8');

  const result = runRouter('stop', {
    session_id: 'stop-session',
    transcript_path: transcript,
    stop_hook_active: false
  }, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"decision":"block"/);
  assert.ok(fs.existsSync(path.join(brain, 'v3', 'stuck-flag.json')), 'think-detect did not receive stdin');
  assert.notEqual(fs.readFileSync(statePath, 'utf8'), before, 'update-state did not run');
  assert.ok(fs.existsSync(path.join(brain, 'v2', 'data', 'audit-log.jsonl')), 'stop-audit did not receive stdin');
});

test('router declares the complete Stop order and reads process stdin once', () => {
  const source = fs.readFileSync(ROUTER, 'utf8');
  assert.equal((source.match(/process\.stdin\.on\(['"]data['"]/g) || []).length, 1);
  const router = require(ROUTER);
  assert.deepEqual(
    router.STOP_HANDLERS.map(item => path.basename(item.script)),
    [
      'stop-audit.js',
      'finish-the-work.js',
      'think-detect.js',
      'capture-lesson.js',
      'update-state.js'
    ]
  );
  assert.equal(router.STOP_HANDLERS.at(-1).always, true);
});

test('inject-context maps every host to the correct display name and diary signature', t => {
  const { env } = freshRuntime(t);
  for (const [host, label, diaryTag] of [
    ['claude-code', 'CC', '[CC泡咪写]'],
    ['codex', 'Codex', '[Codex泡咪写]'],
    ['zcode', 'ZCode', '[ZCode泡咪写]']
  ]) {
    const result = spawnSync(process.execPath, [INJECT_CONTEXT], {
      env: { ...env, CLAUDE_BRAIN_HOST: host, BRAIN_DRY_RUN: '1' },
      input: JSON.stringify({ session_id: `host-${host}`, prompt: '在吗' }),
      encoding: 'utf8',
      timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.additionalContext, new RegExp(`当前宿主：${label}`));
    assert.match(output.additionalContext, new RegExp(diaryTag.replace(/[[\]]/g, '\\$&')));
  }
});

test('inject-context bounds sanitized session ids to 160 characters', t => {
  const { brain, env } = freshRuntime(t);
  const lessonsPath = path.join(brain, 'lessons', 'INDEX.json');
  fs.writeFileSync(lessonsPath, JSON.stringify({
    lessons: [{
      id: 'lesson-session-bound',
      title: 'Bound session ids',
      summary: 'session paths remain bounded',
      severity: 'high',
      status: 'confirmed',
      activation_count: 0
    }]
  }), { mode: 0o600 });
  const longSession = `../../${'x'.repeat(300)}`;
  const result = spawnSync(process.execPath, [INJECT_CONTEXT], {
    env,
    input: JSON.stringify({ session_id: longSession, prompt: '在吗' }),
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  const activationFiles = fs.readdirSync(path.join(brain, 'state'))
    .filter(name => name.startsWith('activated-'));
  assert.equal(activationFiles.length, 1);
  assert.ok(
    activationFiles[0].length <= 'activated-'.length + 160 + '.json'.length,
    `unbounded activation filename: ${activationFiles[0].length}`
  );
  assert.doesNotMatch(activationFiles[0], /\.\.\//);
});
