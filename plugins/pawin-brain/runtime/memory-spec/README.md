# memory-spec

> **File-native graph engineering for agent memory** — edges as `[[wikilinks]]`,
> time as append-only history lines, multi-hop as one-hop link expansion.
> No graph database required.

A structured-memory organization spec for AI agents — a file-based, git-friendly
alternative to opaque vector-only memory. Three-layer index tree, YAML
frontmatter, dual-section (current-conclusion + append-only history) records,
wikilink graph edges, and a small set of maintenance scripts that keep the
tree honest without a human babysitting it.

This package does not ship a memory store — it ships the *shape* a memory
store should have, plus tooling that operates on that shape. It is
runtime-agnostic: nothing here assumes any particular agent harness, model,
or hosting.

**After setup, hand your agent [`AWAKENING.md`](./AWAKENING.md) — the first-run ritual. Its first memory should be its own birth record.**

## Why this shape

Three failure modes motivated every rule in `SPEC.md` (full accident writeups
in `LESSONS-LEARNED.md`):

1. Hand-maintained status snapshots rot — nobody remembers to update them.
2. Retrieval that fails silently degrades for a long time before anyone
   notices.
3. Memory files that get overwritten in place lose the story of *how* a
   conclusion changed, which is often more valuable than the conclusion
   itself.

The spec answers each with a mechanical rule (auto-generated blocks, explicit
failure signaling, append-only history) rather than a policy someone has to
remember to follow.

## Layout

```
memory-spec/
  SPEC.md                 full specification
  LESSONS-LEARNED.md       design history / incident writeups
  templates/               blank files to copy when bootstrapping a tree
    MEMORY.md.template
    INDEX.md.template
    type-user.md.template
    type-feedback.md.template
    type-project.md.template
    type-partner.md.template
    type-reference.md.template
    type-lesson.md.template
  scripts/                 generalized maintenance scripts (Node, no deps)
    generate-index.js       refresh AUTO blocks in an index file
    index-gardener.js       nightly orphan + staleness + diff scan
    link-expand.js           one-hop [[wikilink]] expansion for retrieval
    memory-write-guard.js    write-time format gate (PostToolUse hook)
```

## Quick start

1. **Bootstrap a tree.** Copy `templates/MEMORY.md.template` to
   `$MEMORY_DIR/MEMORY.md` and fill in the six top-level categories you want
   (or fewer — the spec doesn't require all six). Copy
   `templates/INDEX.md.template` into each subdirectory you create.

2. **Set the environment variable every script reads:**

   ```bash
   export MEMORY_DIR=/path/to/your/memory/tree
   ```

   All four scripts fall back to `~/memory` if unset — set it explicitly in
   production. `memory-write-guard.js` specifically reads `MEMORY_GUARD_ROOT`
   first and falls back to this same `MEMORY_DIR` — so setting `MEMORY_DIR`
   alone is enough to keep every script, including the guard, pointed at the
   same tree. Only set `MEMORY_GUARD_ROOT` too if you need the guard to
   enforce a *different* root than the rest of the pipeline reads from.

3. **Wire the write-guard into your agent harness's PostToolUse hook** (or
   equivalent pre-commit/pre-write hook) so every `Write`/`Edit` to a memory
   file is validated before it lands:

   ```bash
   node scripts/memory-write-guard.js < hook-payload.json
   ```

   The script reads a JSON payload with a `tool_input.file_path` field from
   stdin (the common shape emitted by Claude Code–style hooks) and exits 2
   with a stderr explanation on violation, 0 otherwise. Adapt the stdin
   parsing if your harness emits a different envelope.

4. **Schedule `index-gardener.js`** (e.g. nightly cron / launchd) to catch
   orphaned files and stale (`last-verified` > N days) records. It writes a
   report file and, optionally, appends a summary to a daily log if you wire
   `LOG_DIR`.

5. **Call `generate-index.js`** after any process that changes the facts an
   INDEX.md's `<!-- AUTO:NAME BEGIN/END -->` blocks summarize (e.g. at the
   end of an agent turn, or on a timer). It is idempotent and fails silently
   by design — a broken index refresh should never block the agent loop.

   The block name in the marker (`AUTO:NAME`) must exactly match a key in
   `BLOCK_SOURCES` inside `generate-index.js` — the two are wired together
   by name, not by position. `templates/INDEX.md.template` ships with
   `AUTO:STATE` and `AUTO:COUNTS` markers because those are the two example
   keys the shipped `BLOCK_SOURCES` already defines; `COUNTS` works with no
   further setup, `STATE` populates once `MEMORY_DIR/state/status.json`
   exists. If you add your own source function under a new key, add a
   matching `AUTO:<KEY>` marker pair to your index files — the two files are
   not otherwise connected.

6. **Use `link-expand.js`** inside your retrieval pipeline: given a list of
   recalled memory snippets, it expands one hop of `[[wikilink]]` references
   found in the source files so the agent doesn't have to re-query for
   directly-linked context.

## Connecting to an agent's context-injection pipeline

None of these scripts talk to a model. The integration point is whatever
hook your harness runs before/after a turn:

- **Before a turn (context injection):** run your retrieval (grep / embedding
  search / whatever), then pass the results array through `link-expand.js`
  before injecting into the prompt. It's a library, not a CLI — there's no
  stdin/stdout pipe to shell out to; call it in-process:

  ```js
  const { expandLinks } = require('./scripts/link-expand.js');
  const recall = await runYourRetrieval(query); // [{ file: 'slug.md', ... }, ...]
  const expanded = expandLinks(recall, { link_expansion_enabled: true });
  // expanded[i].linkBlock, when present, is the one-hop wikilink expansion
  // to append to that item before it goes into the prompt.
  ```
- **After a turn (write validation):** run `memory-write-guard.js` as a
  PostToolUse hook on file-write tools scoped to `$MEMORY_DIR`.
- **On a timer (maintenance):** run `index-gardener.js` nightly,
  `generate-index.js` after any state-changing operation you want reflected
  in an index's AUTO block.

## License

MIT — see the [LICENSE](../LICENSE) file at the repository root.
