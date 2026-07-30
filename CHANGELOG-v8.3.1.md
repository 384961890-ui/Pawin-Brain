# Brain v8.3.1 — public hardening patch

v8.3.1 repairs the public v8.3 distribution. It does not add private or
post-v8.3 Brain features.

## Fixed

- Claude Code and ZCode now install executable source separately from private
  Brain data, while legacy clone-as-runtime layouts remain compatible.
- Fresh installs create every required seed and hook; repeated installs are
  idempotent and preserve unrelated host settings.
- Session-derived filenames are bounded, sanitized, contained, and stored with
  private permissions. Stop-hook temporary transcripts are always removed.
- The Codex runtime builder copies an exact reviewed file allowlist instead of
  recursively copying source directories.
- The Codex doctor is read-only, rejects runtime drift and extra files, and
  verifies an enabled QMD daemon instead of treating configuration as health.
- Codex hook failures remain fail-open for the host but are now visible instead
  of silently pretending context was injected.
- Both self-test suites run in disposable directories and cannot modify a
  configured live Brain.
- QMD direct Python dependency versions are pinned. Model revisions, sizes,
  and SHA-256 digests are locked and have an offline verifier.
- CI now runs host-install, packaging, path-containment, permission, isolation,
  and public-content regression tests.

## Privacy boundary

- No identity, diary, lesson, memory, session transcript, runtime state, model
  weight, API key, or internal source is part of this patch.
- Optional v2 adversarial tools are not auto-enabled. They may send explicitly
  supplied text to their documented external providers only when a user runs
  them and supplies the required credential.
