# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-06-17

First public release. **Shitcode Red-Light** — a PostToolUse hook that catches
shitcode the moment you write it, and forces a conscious binary choice instead
of letting you cut a corner silently.

### Added
- **6 detectors** (pure, dependency-free, language-agnostic):
  - `hardcoded_secret` — strong patterns (sk-, AKIA, PEM, gh_) reported directly;
    weak patterns require entropy + placeholder exclusion
  - `file_too_long` — yellow flag > 500 lines, red > 800
  - `long_function` — one contiguous code block > 80 real-code lines
  - `dead_code` — commented-out code blocks ≥ 6 lines (JSDoc-exempt)
  - `todo_pileup` — ≥ 5 TODO/FIXME/HACK/XXX in one file
  - `debug_leftover` — ≥ 2 console.log/debugger in non-test files
- **Soft injection only** — never `decision:block`. A PostToolUse block does not
  roll back the written file and causes a "block → retry → block" infinite loop,
  so even secrets are soft-injected (marked 🔴 but not blocking). Hard blocking
  is reserved for a future PreToolUse hook.
- **Three anti-flood gates** — source-extension allowlist + private-path skips;
  512KB large-file gate; per-file throttle (default 15 min, atomic write so
  concurrent sessions don't corrupt the throttle file).
- **Self-exemption** — the tool skips its own install dir (`.claude-brain`) so it
  doesn't flag its own detector source.
- `install.js` — safe, idempotent, append-only hook registration (backs up
  settings.json, never overwrites existing hooks).
- 7-case regression suite (`selftest.js`), passing 7/7.

### Notes
- Everything is tunable in `config.json` — no code changes needed.
- Ships `enabled: false` by default; flip it on after install.

[0.1.0]: https://github.com/384961890-ui/claude-brain/releases/tag/v0.1.0
