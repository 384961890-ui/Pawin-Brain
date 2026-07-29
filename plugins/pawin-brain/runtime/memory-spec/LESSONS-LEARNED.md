# Lessons Learned — Design History

Every rule in `SPEC.md` exists because something broke first. This file
records the failure mechanisms in the abstract, stripped of incident
specifics.
Read this if you're tempted to skip a rule in the spec as "probably
unnecessary" — it usually wasn't, the first time either.

## 1. Hand-Written Status Snapshots Always Rot

**Mechanism:** an index or status file contained a manually-updated summary
block — counts, flags, health indicators. Every one of those numbers was
correct on the day someone typed it and wrong within days, because updating
it required *remembering* to update it as a separate step from whatever
action actually changed the underlying fact. Nobody ever remembers a
separate step reliably, agent or human.

**Fix:** replace every hand-typed status line with a marked region
(`<!-- AUTO:X BEGIN/END -->`) regenerated from a live source of truth by a
script that runs automatically (on a timer, or hooked to the event that
actually changes the fact). The number is now always as fresh as the last
run of the generator, and the generator is cheap enough to run constantly.
See `SPEC.md` §5.1 and `scripts/generate-index.js`.

## 2. Silent Retrieval Failure Can Go Unnoticed for Days

**Mechanism:** a retrieval subsystem's write path had a failure branch that,
instead of surfacing an error, quietly truncated or discarded data and
returned success. Everything downstream kept working — just against a much
smaller, degraded dataset — with no error, no log line a human would notice,
no drop in apparent functionality (queries still returned *something*, just
worse results). The degradation was only caught days later, by accident,
when someone happened to compare an expected result against what actually
came back.

**Fix:** any retrieval or storage layer must treat "operation succeeded but
produced obviously-truncated/degraded output" as a distinct, loud failure
mode — not folded into the success path. Concretely: validate output size
against expected bounds before accepting a write; make health/status checks
report the actual working-set size, not just "process is running"; prefer
an operation that fails loudly over one that "helpfully" degrades and
reports success. Never let a fallback silently become the permanent path.

## 3. Writing Facts From Impression Instead of Verification

**Mechanism:** an agent repeatedly wrote specific facts (names, numbers,
dates, identities) into memory or output based on "I'm pretty sure this is
right" rather than checking. Most of the time it was fine. Often enough it
wasn't, and the wrong fact then got treated as ground truth by everything
that read it afterward, compounding the error.

**Fix:** a hard rule, enforced by convention rather than tooling (this one
can't be mechanically checked): before writing a specific factual claim —
a name, a number, an identity, a project name — into a memory file, verify
it against an authoritative source (grep the existing memory tree, read the
canonical reference file) rather than writing from recollection. "I
remember it being X" is not verification. This matters more, not less, as
an agent's memory tree grows, because a wrong fact written once gets
re-read and re-trusted many times.

## 4. Overwriting a Conclusion Destroys the Evolution That Produced It

**Mechanism:** memory files stored only the current belief about something.
When the belief changed, the file was edited in place. Weeks later, a
question like "why do we think X" or "did we always think this" had no
answer in the memory tree — the only record of the earlier belief and the
reasoning that changed it was gone, unless someone happened to also
remember which git commit to look at (and git history for a long-lived
tree is not always intact — squashes, migrations, and non-git storage
backends all break that assumption).

**Fix:** the dual-section format (`SPEC.md` §3) — every governed memory file
has a Current Conclusion section (overwritten freely) and an append-only
History section (never edited, only appended to, one dated line per change:
what changed, why). This is a file-level equivalent of a temporal knowledge
graph: current value + timestamped changelog, without needing an actual
graph database. The rule that made this stick wasn't "please remember to
add a history line" — it was a write-time gate (Lesson 5.3 in SPEC.md /
`scripts/memory-write-guard.js`) that mechanically rejects a write missing
a History entry.

## 5. Indexes Nobody Maintains Grow Orphans

**Mechanism:** as the number of memory files grew, some fraction of newly
written files were never added to their parent index — the author intended
to, or assumed a later pass would, and it didn't happen. Those files became
effectively invisible to any retrieval path that walked the index tree
(only found by luck, via full-text or embedding search, if at all). Nobody
proactively checks for content nobody can find — that's precisely the
category of problem that doesn't self-report.

**Fix:** a scheduled, read-only "gardener" job that walks every leaf file,
checks whether any ancestor index references it, and reports (never
auto-fixes — auto-fixing risks filing something in the wrong place with no
human judgment) the orphans it finds. Paired with a staleness check
(`last-verified` older than a threshold) and a since-last-run diff, this
turns "quietly growing rot" into a report someone actually sees on a
schedule. See `SPEC.md` §5.4 and `scripts/index-gardener.js`.
