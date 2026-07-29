# Pawin-Brain v9 Codex Windows Friend Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a self-contained Windows ZIP that adds portable v9 reliability features to the public Codex v8.3 plugin without shipping personal data or user-specific paths.

**Architecture:** Keep the existing public `plugins/pawin-brain/` host adapter, then add a small `friend-runtime/` module for selected v9 behavior. The plugin discovers its mutable data directory from `PAWIN_BRAIN_HOME` or Windows `LOCALAPPDATA` at runtime. A release builder copies only an allowlisted set of files, creates the ZIP, and verifies its manifest in an isolated directory.

**Tech Stack:** Node.js built-ins, PowerShell 5.1+, Codex plugin hooks, ZIP via PowerShell `Compress-Archive`.

---

### Task 1: Define portable paths and the friend runtime contract

**Files:**
- Create: `plugins/pawin-brain/friend-runtime/paths.js`
- Create: `plugins/pawin-brain/friend-runtime/loop-breaker.js`
- Create: `plugins/pawin-brain/friend-runtime/memory-freshness.js`
- Create: `tests/friend-runtime/paths.test.js`
- Create: `tests/friend-runtime/loop-breaker.test.js`
- Create: `tests/friend-runtime/memory-freshness.test.js`

- [ ] **Step 1: Write failing path tests**

```js
test('uses PAWIN_BRAIN_HOME without retaining a user path', () => {
  const result = resolvePaths({ PAWIN_BRAIN_HOME: 'D:\\BrainData' }, 'C:\\Users\\Friend\\AppData\\Local');
  assert.equal(result.dataDir, 'D:\\BrainData');
});

test('falls back to LOCALAPPDATA at runtime', () => {
  const result = resolvePaths({}, 'C:\\Users\\Friend\\AppData\\Local');
  assert.equal(result.dataDir, 'C:\\Users\\Friend\\AppData\\Local\\PawinBrain');
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test tests/friend-runtime/paths.test.js`

Expected: FAIL because `friend-runtime/paths.js` does not exist.

- [ ] **Step 3: Implement runtime path resolution**

```js
function resolvePaths(env = process.env, localAppData = env.LOCALAPPDATA) {
  const dataDir = env.PAWIN_BRAIN_HOME || path.join(localAppData || os.homedir(), 'PawinBrain');
  return {
    dataDir: path.resolve(dataDir),
    stateDir: path.join(path.resolve(dataDir), 'state'),
    memoryDir: path.join(path.resolve(dataDir), 'memory')
  };
}
```

Reject an empty path and filesystem roots. Export the function. Do not embed a user name, a home-directory literal, or a machine-specific path.

- [ ] **Step 4: Add portable v9 modules with tests**

Move only generic logic into dependency-free modules:

```js
const verdict = advance(previousState, { kind: 'failure', failureClass: 'transient', operation: 'Bash' });
assert.equal(verdict.status, 'warning');

const status = assess({ 'superseded-by': 'new-plan' }, '2026-07-29');
assert.equal(status.level, 'superseded');
```

`loop-breaker.js` must track hard failures and repeated edits using data passed in by the hook router. `memory-freshness.js` must evaluate frontmatter only and must not name a fixed memory root.

- [ ] **Step 5: Run runtime tests**

Run: `node --test tests/friend-runtime/*.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/pawin-brain/friend-runtime tests/friend-runtime
git commit -m "feat: add portable v9 friend runtime"
```

### Task 2: Wire v9 reliability behavior into the public Codex adapter

**Files:**
- Modify: `plugins/pawin-brain/scripts/bootstrap-runtime.js`
- Modify: `plugins/pawin-brain/scripts/codex-hook-router.js`
- Modify: `plugins/pawin-brain/scripts/doctor.js`
- Modify: `tests/codex/plugin.test.js`

- [ ] **Step 1: Write failing router tests**

Add tests that invoke `PostToolUse` with a disposable `PAWIN_BRAIN_HOME` and assert:

```js
assert.ok(fs.existsSync(path.join(dataDir, 'state', 'circuit-session-test.json')));
assert.match(JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || '', /换方向/);
```

Also add a doctor test asserting `version` is the friend-edition version and its `checks.portableRuntime.ok` value is true.

- [ ] **Step 2: Run plugin tests to verify failure**

Run: `node --test tests/codex/plugin.test.js`

Expected: FAIL because no portable runtime state or doctor check exists.

- [ ] **Step 3: Extend bootstrap without changing existing data**

Make `bootstrap-runtime.js` select the portable data root through `resolvePaths`. Create only `state/` and `memory/` below that root and seed files with exclusive creation (`wx`), preserving existing user files.

- [ ] **Step 4: Extend hook routing**

On `PostToolUse`, map Codex errors into a loop-breaker signal and write only a sanitized session-id state file below the resolved `stateDir`. On `UserPromptSubmit`, append a short breakout prompt only when the circuit enters `warning` or `open`. On recall, annotate stale, expired, or superseded records without dropping their original text.

The output contract remains Codex hook JSON:

```js
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: '...'
  }
}));
```

- [ ] **Step 5: Extend doctor**

Report the dynamic data directory and add checks for the friend runtime modules, writable disposable state directory, and the four Codex hooks. Do not print identity content, memory content, or environment secrets.

- [ ] **Step 6: Run tests**

Run: `node --test tests/codex/plugin.test.js tests/friend-runtime/*.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/pawin-brain/scripts tests/codex/plugin.test.js
git commit -m "feat: integrate v9 reliability into Codex hooks"
```

### Task 3: Add a Codex-agent structured-memory SOP and blank friend templates

**Files:**
- Create: `docs/FRIEND-CODEX-SOP.md`
- Create: `plugins/pawin-brain/templates/memory/MEMORY.md`
- Create: `plugins/pawin-brain/templates/memory/INDEX.md`
- Create: `plugins/pawin-brain/templates/memory/example-project.md`
- Modify: `plugins/pawin-brain/scripts/bootstrap-runtime.js`
- Create: `tests/friend-runtime/templates.test.js`

- [ ] **Step 1: Write a failing bootstrap-template test**

```js
assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'MEMORY.md')));
assert.match(fs.readFileSync(path.join(dataDir, 'memory', 'example-project.md'), 'utf8'), /## 当前结论/);
assert.doesNotMatch(templateText, /真实姓名|客户名|个人日记/);
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test tests/friend-runtime/templates.test.js`

Expected: FAIL because the portable templates do not exist.

- [ ] **Step 3: Write the SOP in Chinese**

The SOP must explain, with fictional content only: the three-layer index tree; Current Conclusion plus append-only History; six record types; grep-first retrieval; one-hop wikilinks; write-time validation; index refresh; gardener review; and the prohibition on secrets and raw transcripts. Include a first-run checklist for a Codex agent.

- [ ] **Step 4: Add safe templates and seed them**

Every leaf template includes frontmatter, `## 当前结论`, and one dated fictional history line. Bootstrap copies templates only when absent, so an upgrade never overwrites a friend's own memory.

- [ ] **Step 5: Run tests**

Run: `node --test tests/friend-runtime/templates.test.js tests/codex/plugin.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/FRIEND-CODEX-SOP.md plugins/pawin-brain/templates/memory plugins/pawin-brain/scripts/bootstrap-runtime.js tests/friend-runtime/templates.test.js
git commit -m "docs: add Codex structured memory SOP"
```

### Task 4: Build Windows install, uninstall, and verification scripts

**Files:**
- Create: `friend-edition/scripts/install.ps1`
- Create: `friend-edition/scripts/uninstall.ps1`
- Create: `friend-edition/scripts/verify.ps1`
- Create: `friend-edition/scripts/package.ps1`
- Create: `friend-edition/README-安装说明.md`
- Create: `tests/windows-scripts.test.js`

- [ ] **Step 1: Write failing static contract tests**

```js
assert.match(install, /\$env:PAWIN_BRAIN_HOME/);
assert.doesNotMatch(install, /C:\\Users\\[^\\]+/i);
assert.match(verify, /node .*doctor\.js/);
assert.match(uninstall, /ShouldProcess/);
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test tests/windows-scripts.test.js`

Expected: FAIL because no friend-edition scripts exist.

- [ ] **Step 3: Implement safe PowerShell commands**

`install.ps1` must locate its package root with `$PSScriptRoot`, validate Node and Codex, set or print `PAWIN_BRAIN_HOME` without displaying private values, then add the plugin from the unpacked local directory. `uninstall.ps1` must declare `SupportsShouldProcess`, remove only the friend plugin and only optional local data under the resolved root after `-PurgeData` confirmation. `verify.ps1` runs the Node doctor against a supplied disposable directory. `package.ps1` creates a ZIP from an already sanitized staging directory.

- [ ] **Step 4: Write the Chinese human install guide**

Explain prerequisites, unzip, PowerShell execution policy note, install, verify, uninstall, and how to hand `docs/FRIEND-CODEX-SOP.md` to the agent. Do not include any developer path or personal account.

- [ ] **Step 5: Run script-contract tests**

Run: `node --test tests/windows-scripts.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add friend-edition tests/windows-scripts.test.js
git commit -m "feat: add Windows friend edition installer"
```

### Task 5: Enforce release sanitization and produce a verified ZIP

**Files:**
- Create: `scripts/build-windows-friend-edition.js`
- Create: `scripts/verify-windows-friend-edition.js`
- Create: `friend-edition/release-allowlist.json`
- Create: `tests/friend-release.test.js`
- Create: `dist/.gitkeep`

- [ ] **Step 1: Write failing release-builder tests**

```js
assert.throws(() => validateText('path /Users/example'), /user-specific path/);
assert.throws(() => validateText('path C:\\Users\\Example'), /user-specific path/);
assert.throws(() => validateText('token sk-' + 'abcdefghijklmnop1234'), /secret/);
assert.equal(validateText('process.env.PAWIN_BRAIN_HOME'), undefined);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/friend-release.test.js`

Expected: FAIL because the release builder does not exist.

- [ ] **Step 3: Implement allowlisted staging and scanning**

The builder copies only allowlisted files into an empty staging directory, rejects symlinks and generated directories, recursively scans UTF-8 text for secrets, private build-time terms, POSIX user paths, Windows user paths, private-runtime markers, and unexpected absolute paths. It writes `manifest.json` with SHA-256 hashes and never copies the build-time private term list.

- [ ] **Step 4: Implement isolated verification**

The verifier creates a fresh temporary root, copies or unpacks staging there, sets a disposable `PAWIN_BRAIN_HOME`, runs the plugin doctor and all Node tests, validates the manifest hashes, and reruns the content scan. It must leave the repository and existing local Brain directories untouched.

- [ ] **Step 5: Build the final archive**

Run: `node scripts/build-windows-friend-edition.js --out dist/Pawin-Brain-v9-Codex-Windows.zip`

Expected: a ZIP plus `Pawin-Brain-v9-Codex-Windows.zip.sha256` and no scan findings.

- [ ] **Step 6: Verify the archive from a clean directory**

Run: `node scripts/verify-windows-friend-edition.js --archive dist/Pawin-Brain-v9-Codex-Windows.zip`

Expected: exit code 0 and a report that states manifest, sanitization, bootstrap, and runtime checks all passed.

- [ ] **Step 7: Run the complete test suite**

Run: `node --test tests/codex/plugin.test.js tests/friend-runtime/*.test.js tests/windows-scripts.test.js tests/friend-release.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts friend-edition/release-allowlist.json tests/friend-release.test.js dist/.gitkeep
git commit -m "release: build verified Windows friend edition"
```
