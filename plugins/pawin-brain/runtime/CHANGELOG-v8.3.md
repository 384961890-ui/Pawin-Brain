# v8.3 — Graph-aware recall & pipeline sync

> Paths below (`scripts/link-expand.js` etc.) are **destination paths in the main claude-brain
> repo**, not paths inside this `main-repo-updates/` folder — the files here ship flat and get
> merged into the main repo's `scripts/` directory. See [README.md](./README.md) for the full
> file-to-destination mapping before merging.

## New

- **One-hop `[[wikilink]]` expansion** (`scripts/link-expand.js`): when recall hits a memory
  file, its `[[linked]]` neighbors' one-line descriptions are appended to the injected
  context. Wikilinks written for humans now work for the retriever too.
  Brakes (hard limits): max 3 links per hit · 600 chars total · one hop only ·
  all IO swallowed (never blocks the hook) · `link_expansion_enabled` config switch.
- **Intent-routed retrieval** (synced into `inject-context.js`): literal grep floor
  (free) → local embedding fast search → reranker (last resort). The router picks a
  tier by query intent, not by running all tiers.
- **Stale-mood folding**: state sections older than 7 days are folded to a one-line
  notice instead of injected verbatim — stale context is worse than none.

## New packages in this repo

- `memory-spec/` — the structured-memory standard: 3-layer index tree, dual-section
  (current conclusion + append-only history = a file-based temporal knowledge graph),
  wikilink graph layer, write-time gate, nightly gardener. Templates + 4 scripts included.
- `qmd-engine/` — local semantic retrieval (embedding recall + reranker), deployment
  guide, and a pitfalls log paid for with real incidents. Uses off-the-shelf open
  models (Qwen3-Embedding-4B, Qwen3-Reranker-0.6B); no training or fine-tuning involved.

## Host packaging

- `plugins/pawin-brain/` packages the same public v8.3 runtime as a native Codex
  plugin. Its hooks cover context injection, successful and failed tool
  telemetry, v6 smell feedback, Stop audit, think-loop detection, lesson
  capture, and state updates.
- `.agents/plugins/marketplace.json` makes this repository directly installable
  with `codex plugin marketplace add`.
- `scripts/build-codex-runtime.js` and `tests/codex/plugin.test.js` enforce
  byte-for-byte public-v8.3 runtime parity and prevent personal/private data
  from entering the plugin bundle.
- This is a host adapter only. The public capability ceiling remains v8.3.
