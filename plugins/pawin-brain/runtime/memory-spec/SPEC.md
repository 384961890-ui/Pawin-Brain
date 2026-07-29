# memory-spec — Structured Memory Organization for AI Agents

Version 1.0. Status: draft, extracted from a production long-running-agent
memory tree and generalized for reuse.

## 0. Goals

An AI agent that persists across sessions needs memory that is:

- **Cheap to query without an LLM call** (grep/glob should answer most
  lookups; embeddings are a fallback, not the default path).
- **Auditable by a human** (plain Markdown + YAML frontmatter, readable in
  any editor, diffable in git).
- **Self-describing** (every file states its own type, purpose, and last
  verification date — no external database required to know what a file is).
- **Resistant to silent rot** (index staleness, retrieval failures, and
  overwritten history are all things this spec makes *visible* rather than
  possible to ignore).

None of this requires a vector database, a graph database, or a specific
agent framework. It is a convention for organizing plain files that any
retrieval layer (grep, embeddings, or both) can sit on top of.

## 0.5 This is Graph Engineering, file-native

The 2026 consensus in agent memory — hybrid retrieval, temporal knowledge
graphs, multi-hop expansion, often bundled under the label **Graph
engineering** — maps onto this spec directly, without a graph database:

| Graph-engineering concept | This spec's implementation |
|:---|:---|
| Entity/relation edges | `[[wikilink]]` cross-references between memory files |
| Temporal knowledge graph (facts carry validity over time) | Dual-section records: Current Conclusion + append-only History lines (`YYYY-MM-DD · what changed · why`) |
| Hybrid retrieval (vector alone is not enough) | Tiered lookup: grep floor → local embedding → reranker |
| Multi-hop / neighbor expansion | `scripts/link-expand.js`: one-hop expansion of `[[links]]` at recall time, hard-capped |
| Graph maintenance (orphans, dangling refs) | `scripts/index-gardener.js` nightly orphan & staleness patrol |

The claim is deliberately modest: this is not a graph database and does not
pretend to be one. It is the core of graph engineering implemented on plain
Markdown, which means it stays greppable, diffable, and auditable — properties
a database-backed graph gives up.

## 1. Three-Layer Index Tree

```
MEMORY_DIR/
  MEMORY.md              ← layer 1: single entry point, one line per memory
  <category>/
    INDEX.md              ← layer 2: category-scoped index, one entry per file
    <slug>.md              ← layer 3: leaf memory file
  <category>/<subdir>/
    INDEX.md
    <slug>.md
```

**Layer 1 — `MEMORY.md`.** The only file an agent's context-injection layer
should read unconditionally (or read the top N lines of) at the start of a
session. It lists every top-level category, a one-line pointer to that
category's `INDEX.md`, and a short "most important right now" section if
the agent's workload has a recency-weighted component. It does **not**
contain memory content — only navigation.

**Layer 2 — category `INDEX.md`.** One file per category directory (and per
meaningfully-sized subdirectory). Lists every leaf file in that
category with enough context (one line to one paragraph) that an agent
scanning the index alone — without opening any leaf file — can decide
whether to go read it. Long is fine here ("verbose over lost" — an index
entry that's too short to be useful is worse than one that's too long to
skim quickly).

**Layer 3 — leaf files.** One memory per file. See §2 for internal format.

Rule of thumb for when a leaf file should exist versus being folded into an
index: if the content requires more than a few sentences of nuance, evidence,
or history, it's a leaf file. If it's a single fact with no expected
evolution, it can live directly in the index.

### 1.1 Retrieval tiering

Layered retrieval keeps cost proportional to precision need:

| Tier | Mechanism | Cost | When |
|---|---|---|---|
| 1 | `grep`/literal match over the tree | free, instant | keyword or entity known |
| 2 | embedding similarity search (local) | local compute, no LLM token | keyword unclear, semantic match needed |
| 3 | embedding + reranker | slower | tier 2 ambiguous, need highest precision |

An automatic router MAY exist, but if precision matters more than
convenience, the caller (LLM) should be free to pick the tier explicitly
rather than trusting a classifier. A "free floor" — running tier 1 first
and only escalating on a miss — is a reasonable default even inside an
automated pipeline, since it's strictly cheaper and never wrong to try.

## 2. Leaf File Format

Every leaf file (outside of freeform/scratch directories — see §6) has this
shape:

```markdown
---
name: short-kebab-case-identifier
description: One sentence — what this memory is, written so an index
  scanning it can decide relevance without opening the file.
metadata:
  type: feedback | project | partner | reference | user | lesson
  last-verified: YYYY-MM-DD
---

# Human-readable title

## Current Conclusion

<the current, actionable state of this memory — what an agent should
believe/do right now. This section is REPLACED wholesale when the
conclusion changes; it is not itself append-only.>

## History

- YYYY-MM-DD · what changed · why
- YYYY-MM-DD · what changed · why
```

### 2.1 Frontmatter fields

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Stable identifier, used as the wikilink target (`[[name]]`) |
| `description` | yes | One sentence, shown in index listings and search results without opening the file |
| `metadata.type` | yes | One of the six memory types (§4) — lets tooling filter/route without content parsing |
| `metadata.last-verified` | recommended | `YYYY-MM-DD`; drives staleness detection (§5.2) |

Frontmatter is intentionally minimal. Anything else project-specific goes
under `metadata` as additional keys — the spec only requires the three
above.

## 3. Dual-Section Records (Current Conclusion + Append-Only History)

This is the mechanism that makes the format equivalent to a lightweight,
file-based **temporal knowledge graph**: every fact has both a current
value and a timestamped changelog of how it got there.

**Rule:** a file in a dual-section-governed directory (§4 — the six typed
categories, not scratch/freeform areas) MUST have exactly two sections in
this shape:

- **Current Conclusion** (name may vary — "结论"/"Conclusion"/whatever the
  house style is, but it must be the first content section): the latest,
  actionable belief. Overwritten in place when it changes.
- **History**: append-only. Every time the Current Conclusion section
  changes, a new line is added here in the format:

  ```
  - YYYY-MM-DD · <what changed, one clause> · <why, one clause>
  ```

  Existing lines are never edited or removed. This is the equivalent of
  git blame for a fact that git blame alone doesn't give you cleanly,
  because it's a semantic diff ("we used to believe X, now we believe Y,
  here's why") rather than a text diff.

**Why this exists:** a memory file that only stores the current belief loses
the evolution of that belief. When an agent (or human) later asks "why do we
think X" or "did we always think X", an overwrite-in-place file has no
answer. A git log can technically answer it if every edit was a separate
commit with a good message, but that's a much heavier and much less
reliable guarantee than a mandatory in-file history section. It also
survives repo squashes, migrations, and non-git storage backends.

**Enforcement:** see `scripts/memory-write-guard.js` (§5.3) — a write-time
gate that rejects any write to a governed file missing frontmatter, missing
a History section, or with a History section containing zero dated entries.
Catching this at write time (not at nightly audit time) means the cost of a
violation is "redo this one write" instead of "silently corrupt for days."

## 4. Six Memory Types

These are a starting taxonomy, not a hard limit — projects may add types.
The point of having named types at all is that different types get
different maintenance policies and different agent behavior:

| Type | Purpose | Typical maintenance policy |
|---|---|---|
| `user` | Facts about the human(s) the agent serves — identity, preferences, constraints | Rarely changes; high-confidence bar to edit |
| `feedback` | Corrections the agent received — "you did X, it should have been Y" | Append frequently; each entry should generalize into a rule, not just record the incident |
| `project` | State of an ongoing piece of work | Changes often; Current Conclusion should reflect "what's true right now", not a full changelog (that's what History is for) |
| `partner` | Facts about a third party (person/org) the agent interacts with on the user's behalf | Verify before quoting in anything user-facing |
| `reference` | Reusable technical/procedural knowledge (how a tool works, a fixed procedure) | Re-verify after the underlying tool/procedure changes |
| `lesson` | A distilled, generalizable rule extracted from one or more incidents | Should be short — a maxim, not a case report |

Directories that do **not** get the dual-section treatment: anything the
project designates as a scratch/working area (session logs, diaries,
credentials/secrets vaults, raw archives). Mark these explicitly as exempt
in your own house rules — the write-guard script (§5.3) takes an explicit
allowlist of governed top-level directories for exactly this reason.

## 5. Maintenance Mechanisms

Manually maintained state rots (see `LESSONS-LEARNED.md` §1). Every
mechanism below exists to make a specific kind of rot either impossible or
loudly visible.

### 5.1 AUTO Blocks

An `INDEX.md` (or any file) may contain a machine-owned region:

```markdown
<!-- AUTO:SECTION_NAME BEGIN -->
...generated content...
<!-- AUTO:SECTION_NAME END -->
```

Convention: humans/agents never hand-edit content between these markers.
A script (see `scripts/generate-index.js`) regenerates the region from a
live source of truth (a health-check endpoint, a state file, a directory
listing — whatever is authoritative) and does a scoped regex replace. This
converts "someone forgot to update the status line" from a recurring
failure into a non-issue, because there's no longer a step where a human
has to remember.

Design constraints for any AUTO-block generator:
- **Idempotent.** Running it twice in a row produces the same output.
- **Fails silently, never blocks.** If the generator can't read its source
  of truth, it should leave the block unchanged and exit 0, not crash the
  caller (typically a Stop/end-of-turn hook).
- **Scoped.** Only touches text between its own named markers — never
  rewrites the rest of the file.

### 5.2 Staleness Detection (`last-verified`)

Any file with `metadata.last-verified` older than a configurable threshold
(default suggestion: 90 days) for a category that's expected to change
(project/partner/reference — not lesson, which is meant to be durable) gets
flagged by the nightly gardener (§5.4). "Flagged" means surfaced in a report
— not auto-deleted, not auto-marked-stale in the file itself. A human or the
agent decides whether the fact still holds.

If `last-verified` is absent, fall back in this priority order: git last
commit time for that path → filesystem mtime. Both are weaker signals (a
file can be touched without its *content* being re-verified) so treat them
as lower-confidence than an explicit frontmatter date.

### 5.3 Write-Time Format Gate

A hook (see `scripts/memory-write-guard.js`) runs on every write to a file
under a governed directory and rejects (non-zero exit + explanation) writes
that:

- lack a well-formed frontmatter block,
- lack `name`/`description`/`metadata.type`,
- have a malformed `last-verified` date,
- lack a `## History` section, or
- have a `## History` section with zero dated entries.

This is strictly better than a nightly audit for the same violations,
because the cost of catching a problem at write time is "fix this one
write"; the cost of catching it at 2am the next day is "figure out which of
today's dozen writes broke the rule, and hope nothing downstream already
read the bad version."

The gate should fail open on anything outside its narrow contract —
internal errors, unreadable files, paths outside the governed root — so a
bug in the gate itself never blocks unrelated work.

### 5.4 Nightly Gardener (Orphan + Staleness + Diff Scan)

A scheduled job (see `scripts/index-gardener.js`) that:

1. Walks every governed directory, collects all leaf `.md` files.
2. **Orphan check:** for each leaf file, walks up its directory chain
   looking for an `INDEX.md` (or the root `MEMORY.md`) that references its
   filename. Files referenced nowhere are orphans — content nobody can find
   through the index tree, only through a full-text/embedding search that
   might miss it too.
3. **Staleness check:** per §5.2, on the categories expected to be kept
   fresh.
4. **Diff-since-last-run check:** if the tree is under git, diffs the
   current HEAD against the commit recorded on the previous run, flagging
   any changed file not referenced in its nearest index — catches the case
   where a file was edited but its parent index wasn't updated to reflect a
   meaningfully different scope.
5. Writes a report file and (optionally) appends a summary to a daily
   log — deduplicated by a content fingerprint so the same finding doesn't
   spam the log every run.

This tool is read-only with respect to memory content — it never edits,
moves, or deletes a memory file. It only produces a report a human or agent
acts on.

## 6. Wikilinks — the Graph Layer

Any leaf file may reference another by `[[slug]]`, where `slug` is the
target file's `name` frontmatter field (or a well-known ID scheme like
`L-001` for lessons, if the project uses IDs instead of file-based slugs).
This is the edge set of an implicit knowledge graph laid on top of the
directory tree.

**One-hop expansion (`scripts/link-expand.js`):** when a retrieval pass
returns a memory file, the retrieval layer may expand `[[links]]` found in
that file's body by one hop — pulling in each linked file's `description`
line — so the agent sees "this fact connects to these other three facts"
without issuing a second query. Hard limits keep this bounded:

- expand exactly one hop, never recurse into the neighbor's own links,
- cap the number of links expanded per source file (e.g. 3),
- cap the total expanded text length per source file (e.g. 600 characters),
- unresolvable slugs (file not found, no `description` field) are skipped
  silently, not treated as errors.

These limits exist because unbounded graph expansion turns a bounded
retrieval cost into an unbounded one — exactly the kind of context-window
blowup a hook running on every turn cannot afford.

## 7. Archival, Never Deletion

When a memory is superseded or no longer relevant, move the file into an
`_archive/` subdirectory (or equivalent) rather than deleting it, and leave
one line at the top of the file (or in the archive's own index) stating why
it was archived and what superseded it. Tooling that treats `_archive/` as
excluded from orphan/staleness scans (as in §5.4) should still count
archived files as intentionally present, not as rot.

## 8. Minimal Compliance Checklist

A memory tree conforms to this spec if:

- [ ] There is exactly one root `MEMORY.md` acting as the single entry point.
- [ ] Every category directory has an `INDEX.md` listing its leaf files.
- [ ] Every leaf file in a governed category has frontmatter with
      `name`, `description`, `metadata.type`.
- [ ] Every leaf file in a governed category has a Current Conclusion
      section and an append-only `## History` section with at least one
      dated entry. **Note:** the shipped `memory-write-guard.js` only
      machine-checks the `## History` half of this (the Current Conclusion
      heading's name is explicitly allowed to vary by house style — see §3
      — which makes it a poor candidate for a fixed regex check). Current
      Conclusion presence is a house-policy / human-review item unless you
      extend the guard for your own fixed heading name.
- [ ] A write-time or scheduled mechanism exists to catch violations of the
      above (does not have to be the exact scripts in `scripts/`).
- [ ] Superseded content is archived, not deleted.
