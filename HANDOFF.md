# Pawin Brain public v8.3.1 handoff

## Current status

- Delivery branch: public `main`
- Pull request: <https://github.com/384961890-ui/Pawin-Brain/pull/3> (merged)
- Source baseline: public `main` at `6e83aa8bfea8485f520710ce150b25f0a0985eeb`
- Verified code merge: `f9c2649673ecf1d61db66df91fd849a84291e91f`
- Scope: maintenance and distribution hardening for the public v8.3 feature
  line only; no private v9 source or runtime data is included
- Release state: published as
  [`v8.3.1`](https://github.com/384961890-ui/Pawin-Brain/releases/tag/v8.3.1)

## Repository workflow

- The owner authorized future verified public maintenance increments for this
  repository to push directly to `main` after tests, privacy checks, and remote
  confirmation.
- Tags, GitHub Releases, repository visibility changes, and production
  publication still require explicit owner approval.

## This increment

- Separated executable source from user data for new Claude Code and ZCode
  installs while retaining protected legacy clone-as-runtime compatibility.
- Repaired fresh, repeated, custom-path, and uninstall behavior for Claude Code,
  Codex, and ZCode host adapters.
- Contained session-derived paths, enforced private runtime permissions, and
  moved Stop-hook transcripts into unique private temp directories that are
  removed on every exit path.
- Made Codex rollout conversion read only a bounded regular-file tail.
- Made ZCode runtime-file replacement transactional, added exact uninstall
  ownership, allowed legitimate system-level symlink ancestors, and rejected
  symlinks inside the Brain tree.
- Replaced recursive Codex packaging with an exact reviewed allowlist and
  manifest validation.
- Made the Codex doctor read-only, exact about hook contracts, and hostile to
  runtime/data/router symlink substitution; fail-open hook failures are visible.
- Isolated both self-test suites from live Brain data.
- Pinned QMD direct dependency versions; locked model revisions, sizes, and
  SHA-256 digests; and added an offline model verifier.
- Added SHA-pinned CI and regression coverage for installation, rollback,
  packaging, path containment, permissions, data isolation, hook budgets, and
  public-content safety.

## Verification evidence

The following checks passed after rebuilding the generated Codex runtime:

```text
node --test tests/claude/*.test.js tests/codex/*.test.js \
  tests/security/*.test.js tests/selftest/*.test.js tests/zcode/*.test.js

69 tests passed; 0 failed
```

Additional release gates:

- all tracked JavaScript sources parse with `node --check`
- all tracked shell sources parse with `bash -n` or `sh -n` as appropriate
- QMD and v2/v6 Python sources parse successfully with the Python AST parser
- JSON manifests, the runtime allowlist, and the QMD model lock parse
- `git diff --check` passes
- generated runtime contains exactly 97 allowlisted public files
- rebuilding the generated runtime twice is byte-stable
- public-content scans find no personal machine path, credential shape, runtime
  data, private v9 path, or unreviewed runtime file
- a fresh clone of the remote delivery branch passed the same 69-test suite,
  rebuilt all 97 runtime files byte-for-byte, and remained Git-clean
- pull-request CI passed on both Node.js 20 and Node.js 22 for code commit
  `4ee7ad9e72dd8a988330dadc374627d98fd39fdf`
- after merge, a fresh default clone of public `main` resolved to
  `f9c2649673ecf1d61db66df91fd849a84291e91f`, reported plugin version `8.3.1`,
  passed 69/69, rebuilt the 97-file runtime, and remained Git-clean
- the post-merge `main` workflow run `30554916369` completed successfully
- annotated tag `v8.3.1` peels to
  `91dc130a7f12886d521f92b2804fdf3f08958234`
- a clean clone of `v8.3.1` reported plugin version `8.3.1`, passed 69/69,
  rebuilt the 97-file runtime byte-for-byte, and remained Git-clean

## Not completed

- An older public remote branch contains post-v8.3 design material and two
  user-specific absolute-path fixtures. Its exact name and sanitized evidence
  are recorded in the private release audit. Deleting or rewriting that remote
  branch is outside this repair and requires explicit owner approval.
- Rewriting historical author metadata is outside this repair and requires
  explicit owner approval.
- QMD's direct Python packages are version-pinned, but the complete transitive
  Python build graph is not hash-locked across platforms. Model artifacts are
  independently hash-locked.
- ZCode rolls runtime-file replacements back after a later configuration
  failure. Generic seed data and directories created by the bootstrap are
  intentionally retained, so installation is not a whole-tree transaction.
## Next step

Keep `v8.3.1` immutable. Future verified public maintenance can continue on
`main`; any later version tag or GitHub Release still requires explicit owner
approval.
