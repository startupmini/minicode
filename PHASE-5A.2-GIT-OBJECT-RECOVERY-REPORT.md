# PHASE 5A.2 — GIT OBJECT RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Target: recycled copy of the specimen, `D:\$RECYCLE.BIN\…\$R3F30GQ`
**READ-ONLY FORENSICS. No TaskGraph source, no design, no implementation, no commit.**

---

## DECISION

# TASKGRAPH SOURCE NOT FOUND IN GIT OBJECTS

**Git-object recovery is exhausted.** Combined with 5A.1 (registry, caches, other
repos) and 5A (artifact inventory), **forensic recovery of the TaskGraph source is
now permanently closed.** TaskGraph is **NEW ARCHITECTURE**.

---

## 1. Exact recycle-bin path

| field | value |
|---|---|
| copy | `D:\$RECYCLE.BIN\S-1-5-21-3966295346-2044609687-3549619457-1001\$R3F30GQ` |
| original path (`$I3F30GQ`) | `D:\git\minicode` — the specimen |
| `.git` present | yes (254 files, 5 743 166 B) |
| authorization | explicit user approval; **read-only only** |

Safety measures taken before any Git call: `GIT_INDEX_FILE` pinned to a
non-existent temp path and `GIT_OPTIONAL_LOCKS=0`, so the repository index and any
lock could not be touched. No write verb was used: no checkout, reset, restore,
commit, gc, prune, repack, fetch, pull, push, and **no `fsck --lost-found`**.

## 2. Repository metadata

| item | value |
|---|---|
| `HEAD` | `4d69adfb02dd5a36f925f9e7d61d559e79bc4fbc` |
| `ORIG_HEAD` | `7417d0d09c6d55dc6877b67bce19d4f93655da4a` |
| identity | `HEAD` == `refs/heads/main` == **tag `v0.9.29`** |
| local branches | 8 (`docs-sync`, `main`, `blog/query-gratis`, `docs/solution-explorer-decisions`, `feat/seo-audit-fixes`, `fix/input-resize-invalidation`, `fix/uiux-audit-findings`, `release/0.9.29`) |
| remote refs | 11 under `origin/` |
| tags | `v0.1.3 … v0.9.29` (+ a `freebuff-snapshot` tag) |
| objects | **5 387** = 1 853 trees · 3 127 blobs · 404 commits · 3 tags |

**This snapshot stops at v0.9.29 — published 2026-09-18.** The task subsystem
post-dates the v0.12.0 tag (2026-09-25) by three days. This copy predates the
`src/task/` subsystem entirely.

## 3. Reflog findings

`logs/HEAD` has **94 entries**; 30 additional per-ref logs exist. Every entry is a
`commit`, `pull`, `push`, `checkout`, `reset`, `rebase` or `amend` on **UI, web/SEO,
docs, CI, memory-hardening and provider** work. Examples: *"feat(web): motion penuh
+ SEO audit"*, *"chore: rilis 0.9.29"*, *"fix(ci): perbaiki 3 kegagalan"*.

- Final action: `checkout: moving from release/0.9.29 to origin/main`
- Final timestamp: **2026-09-18 18:00:49 +07:00**
- **No reflog entry mentions task, graph, readiness or scheduler.**
- One historical ref is worth recording but is **not** TaskGraph: `packed-refs`
  still lists `refs/heads/main = 76ed3b1d`, older than the loose `4d69adfb` — the
  usual signature of a branch that advanced after the pack was written.

## 4. fsck findings

| variant | result |
|---|---|
| `git fsck --full --unreachable` | 155 lines, exit 0 |
| `git fsck --full --no-reflogs --unreachable` | 160 lines, exit 0 |
| errors / warnings / missing / broken | **0** |
| dangling commits / trees / blobs | **0** (every object is *unreachable*, each still referenced by another unreachable object) |

The 5-line difference between variants is expected: without reflogs, five
reflog-only objects also become unreachable. `--lost-found` was **not** used, so
nothing was materialised.

## 5. Unreachable commits

**46 unreachable commits**, read as raw objects with `cat-file` (not by date
assumption, but by object content):

- Date range **2026-09-03 … 2026-09-18**
- Commits dated **2026-09-25 or later: 0** — the entire task-subsystem window
- Subjects matching `task|graph|readiness|schedul`: **0**
- All 46 are `git stash`-style entries — `WIP on …`, `index on …`,
  `untracked files on …` — i.e. abandoned local work on web/UI/SEO/docs branches
- **Unreachable commits containing any `src/task/` path: 0**

## 6. Candidate trees / blobs

An exhaustive sweep was run over the **entire object database**, not merely
reachable history:

| scan | scope | result |
|---|---|---|
| tree paths | **all 1 853 trees** via `ls-tree -r` | **0** contain any `src/task/` path |
| blob content | **all 3 127 blobs** via `cat-file` | **0** contain `TaskGraph`, `graph-validate`, `readyTasks`, `canExecute`, `blockingDeps`, `sourceRevision`, `eligibleForReadiness` |
| reachable + reflog history | `log --all --reflog --name-only` | **0** `src/task/` paths |

## 7. TaskGraph path matches

**None.** The three target paths appear in **no** tree, **no** commit, reachable
or unreachable, and **no** blob contains the associated vocabulary.

## 8. Content correlations

**None.** A filename is insufficient, and so is vocabulary: 3 127 blobs were
content-scanned for the TaskGraph vocabulary with zero hits. Nothing in this object
database ever referenced the lost modules — consistent with 5A, where none of the
five pre-wipe `*.orig.ts` artifacts referenced them either (they were self-contained
leaves).

## 9. Provenance classification

| candidate | classification | basis |
|---|---|---|
| 5 387 objects (incl. 46 stash commits) | **UNRELATED OBJECT** | no target path, no vocabulary, none in the task window |
| blob `6d78359f` (5 180 B) | **UNRELATED OBJECT** | **size-identical to `graph-validate.ts` but is `src/providers/router.ts`** — a provider router, 0 occurrences of `graph`/`readiness`/`cycle`/`dependsOn`/`taskId`. A pure size coincidence, investigated and rejected |
| `pack.json` | **REPORT-ONLY EVIDENCE** | names the files, contains no payload |
| Brief vocabulary (`canExecute`, `DEP_*`, `sourceRevision`, `blockingDeps`) | **INSUFFICIENT PROVENANCE** | zero occurrences in this database |

## 10. Package correlation

| manifest target | size | blobs of exactly that size | verdict |
|---|---|---|---|
| `src/task/graph.ts` | 9 332 B | **0** | absent |
| `src/task/readiness.ts` | 6 346 B | **0** | absent |
| `src/task/graph-validate.ts` | 5 180 B | 1 → `src/providers/router.ts` | **UNRELATED** |

No blob in the database is a plausible candidate for any of the three files. The
largest blobs are 185 KB / 183 KB / 177 KB / 165 KB — none near the target sizes,
so the size match for `graph-validate.ts` was the only coincidence and it is
refuted on content.

## 11. Negative evidence (explicit proof)

Under **this object database**:

- **no reachable commit** contains `src/task/graph.ts`, `graph-validate.ts` or
  `readiness.ts`;
- **no unreachable commit** does either (all 46 inspected individually);
- **no dangling tree/blob** exists at all (fsck reported 0);
- **no relevant blob** exists (3 127/3 127 content-scanned, 0 hits);
- **no reflog reference** points at task-related work (94 + 30 log files read).

This claim is scoped to this object database and this machine. I do not claim it
about any backup that may exist elsewhere.

The reason is structural, not accidental: the repository stopped on **2026-09-18**,
while the task subsystem only appeared in local, uncommitted working files between
the **v0.12.0 tag (2026-09-25)** and the **wipe (2026-09-28)**. It was therefore
never in this database, never in a tag, and never in a published tarball.

## 12. Final safety check

| check | result |
|---|---|
| active specimen `D:\git\minicode` | untouched (`project-id` mtime 02:02:37) |
| recycle-bin copy `.git` | **254 files, byte-identical to the pre-scan baseline** — no file added, removed, resized or re-timestamped |
| stray `*.lock` / fsck artefacts inside the copy | **0** |
| refs changed | none (no write verb used) |
| git objects written | none (read verbs only; `GIT_OPTIONAL_LOCKS=0`) |
| files created inside either repository | **0** |

## 13. What happens next

Per the phase's stop rule, forensic recovery is **permanently closed**. The
consequences carry forward unchanged from 5A:

- Blocker model, `canExecute`, readiness predicate, cycle algorithm, batch
  semantics and staleness policy are all **UNKNOWN** — not reconstructed, not
  guessed.
- **READY is not storable**: it is not a member of `TaskStatus` and is coerced to
  `PENDING`, so readiness must be *derived*. This conflict resolves in favour of
  the Identity Foundation.
- Both cycle kinds are **persistable today** (measured), so cycle validation is a
  real requirement with no recoverable prior design.
- A missing dependency is impossible (rejected at write) while a missing parent is
  reachable — the graph alone must interpret the latter.
- The pre-wipe project's "Phase 5/6/7" is a **control-plane/present體** series
  unrelated to the recovery's phase numbering.

**TaskGraph is NEW ARCHITECTURE and must now be designed from explicit
requirements, with every former unknown recorded as a deliberate product decision
rather than filled in from memory.**
