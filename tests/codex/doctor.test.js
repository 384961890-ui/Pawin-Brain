'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const DOCTOR = path.join(ROOT, 'plugins/pawin-brain/scripts/doctor.js');
const BOOTSTRAP = path.join(ROOT, 'plugins/pawin-brain/scripts/bootstrap-runtime.js');
const PLUGIN = path.join(ROOT, 'plugins/pawin-brain');

function snapshot(root) {
  const rows = [];
  const walk = (target, relative = '.') => {
    const stat = fs.lstatSync(target);
    rows.push(`${relative}|${stat.mode & 0o777}|${stat.size}|${stat.mtimeMs}`);
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(target).sort()) {
      walk(path.join(target, name), path.join(relative, name));
    }
  };
  walk(root);
  return rows.join('\n');
}

function makeDoctorFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-doctor-adversarial-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plugin = path.join(base, 'plugin');
  const home = path.join(base, 'home');
  const brain = path.join(base, 'brain');
  fs.cpSync(PLUGIN, plugin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, CLAUDE_BRAIN_DIR: brain };
  const bootstrap = path.join(plugin, 'scripts/bootstrap-runtime.js');
  const boot = spawnSync(process.execPath, [bootstrap], {
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(boot.status, 0, boot.stderr || boot.stdout);
  const configPath = path.join(brain, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.qmd_enabled = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return {
    base,
    brain,
    env,
    plugin,
    doctor: path.join(plugin, 'scripts/doctor.js')
  };
}

function runDoctor(fixture) {
  const result = spawnSync(process.execPath, [fixture.doctor], {
    env: fixture.env,
    encoding: 'utf8',
    timeout: 10000
  });
  return { result, report: JSON.parse(result.stdout) };
}

test('doctor is read-only and does not claim an absent data root is healthy', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-doctor-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brain = path.join(home, 'missing-brain');
  const result = spawnSync(process.execPath, [DOCTOR], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_BRAIN_DIR: brain,
      QMD_DAEMON_URL: 'http://127.0.0.1:9'
    },
    encoding: 'utf8',
    timeout: 10000
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(brain), false, 'doctor mutated the missing data root');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'error');
  assert.equal(report.checks.data.ok, false);
  assert.notEqual(report.checks.qmd?.ok, true);
});

test('doctor reports a bootstrapped QMD-disabled Brain healthy without mutating it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawin-doctor-healthy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const brain = path.join(home, 'brain');
  const env = { ...process.env, HOME: home, CLAUDE_BRAIN_DIR: brain };
  const boot = spawnSync(process.execPath, [BOOTSTRAP], {
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(boot.status, 0, boot.stderr);
  const configPath = path.join(brain, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.qmd_enabled = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const before = snapshot(brain);
  const result = spawnSync(process.execPath, [DOCTOR], {
    env,
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ok');
  assert.equal(report.readOnly, true);
  assert.equal(report.checks.data.ok, true);
  assert.equal(report.checks.runtime.ok, true);
  assert.equal(report.checks.hooks.ok, true);
  assert.deepEqual(report.checks.qmd, {
    ok: true,
    enabled: false,
    status: 'disabled'
  });
  assert.equal(snapshot(brain), before);
});

test('doctor rejects a symlinked data component instead of following external data', t => {
  const fixture = makeDoctorFixture(t);
  const external = path.join(fixture.base, 'external-lessons');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'INDEX.json'), '{"lessons":[]}\n', { mode: 0o600 });
  fs.rmSync(path.join(fixture.brain, 'lessons'), { recursive: true, force: true });
  fs.symlinkSync(external, path.join(fixture.brain, 'lessons'), 'dir');
  const { result, report } = runDoctor(fixture);
  assert.equal(result.status, 1);
  assert.equal(report.checks.data.ok, false);
  assert.ok(report.checks.data.unsafePaths.includes('lessons'));
});

test('doctor rejects hook event swaps and unexpected hook commands', t => {
  const fixture = makeDoctorFixture(t);
  const hooksPath = path.join(fixture.plugin, 'hooks/hooks.json');
  const document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  document.hooks.UserPromptSubmit = document.hooks.Stop;
  document.hooks.UnexpectedEvent = document.hooks.Stop;
  fs.writeFileSync(hooksPath, `${JSON.stringify(document, null, 2)}\n`);
  const { result, report } = runDoctor(fixture);
  assert.equal(result.status, 1);
  assert.equal(report.checks.hooks.ok, false);
  assert.ok(report.checks.hooks.invalidEvents.includes('UserPromptSubmit'));
  assert.ok(report.checks.hooks.unexpectedEvents.includes('UnexpectedEvent'));
});

test('doctor rejects a symlinked runtime root and a symlinked hook router', t => {
  const runtimeFixture = makeDoctorFixture(t);
  const runtime = path.join(runtimeFixture.plugin, 'runtime');
  const externalRuntime = path.join(runtimeFixture.base, 'external-runtime');
  fs.renameSync(runtime, externalRuntime);
  fs.symlinkSync(externalRuntime, runtime, 'dir');
  const runtimeResult = runDoctor(runtimeFixture);
  assert.equal(runtimeResult.result.status, 1);
  assert.equal(runtimeResult.report.checks.runtime.ok, false);
  assert.ok(runtimeResult.report.checks.runtime.unsafeLinks.includes('.'));

  const routerFixture = makeDoctorFixture(t);
  const router = path.join(routerFixture.plugin, 'scripts/codex-hook-router.js');
  const externalRouter = path.join(routerFixture.base, 'external-router.js');
  fs.renameSync(router, externalRouter);
  fs.symlinkSync(externalRouter, router);
  const routerResult = runDoctor(routerFixture);
  assert.equal(routerResult.result.status, 1);
  assert.equal(routerResult.report.checks.hooks.ok, false);
  assert.equal(routerResult.report.checks.hooks.routerExists, false);
});

test('QMD health checks enforce an absolute deadline and a bounded response body', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'application/json' });
      const interval = setInterval(() => response.write(' '), 20);
      response.on('close', () => clearInterval(interval));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('x'.repeat(70 * 1024));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  const { requestHealth } = require(DOCTOR);

  const started = Date.now();
  const timedOut = await requestHealth(
    `http://127.0.0.1:${address.port}/stream`,
    100
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(timedOut, { ok: false, status: 'timeout' });
  assert.ok(elapsed < 800, `absolute timeout took ${elapsed}ms`);

  const oversized = await requestHealth(
    `http://127.0.0.1:${address.port}/large`,
    1000
  );
  assert.deepEqual(oversized, { ok: false, status: 'response_too_large' });
});
