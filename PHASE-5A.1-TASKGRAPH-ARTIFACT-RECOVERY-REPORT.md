# PHASE 5A.1 — TASKGRAPH ARTIFACT RECOVERY REPORT

Workspace: `D:\recover\minicode-20260928\reconstruction`
Audited HEAD: `ac53069` (the brief's stated `2b2d648` was stale — see §0)
**FORENSIC ARTIFACT RECOVERY ONLY. No design, no implementation, no commit.**

---

## 0. Checkpoint discrepancy (flagged, not blocking)

The brief states HEAD `2b2d648`. Actual HEAD is **`ac53069`** — the Phase 5A
report, which you asked me to commit after 5A was written. The delta from `2b2d648`
is **one documentation file**; no source changed. This phase makes no source change
either, so the discrepancy is inert.

## DECISION

# TASKGRAPH SOURCE NOT RECOVERABLE

**Artifact recovery exhausted under current search scope.**

The three files are confirmed lost, and the loss is now *explained* rather than
merely observed: the entire `src/task/` subsystem — including the TaskGraph — was
**never committed to any Git repository and never published to any registry**. It
existed only as uncommitted local working-tree files, captured solely by a local
`npm pack` output whose contents (`pack.json`) name the files but do not contain
them.

---

## 1. Package manifest evidence (the anchor)

`pack.json` is a complete **`npm pack` output** for `minicode-ai@0.12.0`:

| field | value |
|---|---|
| name / version | `minicode-ai` / `0.12.0` |
| id | `minicode-ai@0.12.0` |
| shasum | `06ec96f5800c08a0125e1160245fe691af50ac35` |
| integrity | `sha512-Nia0dNpnWAhZQENrbwxAVpfXne/FEp5cLvdxUz0/FNKw2ZdR9yGbsSy+1nHFP5rkt2D9vLGBPKhH05sz8wmdZg==` |
| tarball size | 783 719 B · unpacked 2 382 955 B · **224 files** |
| publish metadata | **none** (no `time`, no `_resolved`) |

The manifest **lists** `src/task/graph.ts` (9332 B), `graph-validate.ts` (5180 B),
`readiness.ts` (6346 B) — it is a *file listing*, not a payload. No tarball, no
hash and no blob for those files exists in any artifact I could reach.

**Critical implication:** 0.12.0 has **no publish metadata and no registry
presence**, so this manifest describes a local `npm pack` of an unpublished build.

## 2. Search locations (all searched, all negative)

| location | result |
|---|---|
| `~/.bun/install/cache` (4143 entries) | no `minicode*` entry (holds dependencies only) |
| npm cache (`npm-cache`, `.npm\_cacache`) | 0 matches |
| Yarn cache | absent on this machine |
| `~/Downloads` | absent |
| `%TEMP%` (110 291 entries) | forensics dir inspected; no `graph.ts`/`readiness.ts` |
| `D:\recover` | reconstruction + `repo-from-remote`, both negative |
| 32 Git repositories on C:/D: (excluding the specimen) | see §5 |
| Recycle Bin | see §6 — a recycled copy of the specimen, negative |

## 3. Local artifact findings

No local `minicode-ai-0.12.0.tgz` or any 0.12.0 artifact exists. Full-disk
recursive search by filename exceeded a 15-minute budget, so the negative is
established through the targeted cache/registry/git scopes below rather than an
exhaustive byte scan — stated plainly as a scope limit.

## 4. Registry findings — the strongest evidence

Network **is** available (control: `npm view lodash` → 4.18.1), and
`minicode-ai` **does exist** on the public registry — but it has **7 versions**:

```
0.9.26  0.9.27  0.9.28  0.9.29  0.10.0  0.11.0  0.11.1      (latest = 0.11.1)
created 2026-09-17   last modified 2026-09-24
```

**`0.12.0` was never published** (`npm view minicode-ai@0.12.0` → E404 while the
unversioned query succeeds — so this is "not published", not "registry blocked").

I downloaded and inspected **all 7 published tarballs**. Result:

| version | tarball | `package/src/task/` |
|---|---|---|
| 0.9.26 … 0.11.1 | 476 KB – 679 KB | **absent in every version** |

`src/` exists in all of them (`src/agents … src/ui`), but **`src/task/` never
appears in any published version.** The whole task subsystem post-dates the last
publication.

Provenance recorded (sha256 prefixes, then tarballs deleted per §10):
`0.9.26 F3F8C788…`, `0.9.27 F9CC69B1…`, `0.9.28 91017F7C…`, `0.9.29 9FAE221F…`,
`0.10.0 A7EBD734…`, `0.11.0 07A6882A…`, `0.11.1 EF7B9536…`, each cross-checked
against its registry `dist.integrity`.

## 5. Git object findings

The reconstruction repo carries **28 imported tags** and a full pack, so I looked
hard here.

- **Tag `v0.12.0` = `cb633e4`, "release: MiniCode 0.12.0 (output architecture
  Phase 3-7)", 2026-09-25.** Its tree has **506 files and no `src/task/`**. The only
  "readiness" match is `test/release-readiness.test.ts` — the packaging false lead
  already rejected in 5A.
- **8 dangling commits** — all recovery-era WIP (`WIP on main`, phase-0 restores,
  a web CHANGELOG commit). `src/task/` in them contains only `identity.ts`,
  `model.ts`, `store.ts` — **my** reconstructed files, not pre-wipe source.
- `git log --all --name-only` finds **no** `src/task/graph*.ts` or `readiness.ts`
  in any commit.
- Other MiniCode-adjacent repos — `D:\code\minicode\minicore`, `D:\git\minicore`,
  `D:\recover\minicode-20260928\repo-from-remote`, `D:\git\startupmini` — **none has
  `src/task/` in its working tree or any commit.** The upstream clone
  (`repo-from-remote`) has the same 27 tags, also negative.
- No `.bundle` files were located (that sweep hit the time budget).

## 6. A recycled copy of the specimen — negative, and I did not read its contents

The Recycle Bin contains `$R3F30GQ`, whose `$I3F30GQ` metadata gives the original
path as **`D:\git\minicode.`** — a deleted copy of the specimen, including a
complete `.git` (`objects/`, `refs/`, `packed-refs`, `FETCH_HEAD`, `ORIG_HEAD`,
`logs/`) and `node_modules`.

**I listed directory names and sizes only. I did not read any file content, and I
did not run Git against it**, because the instruction was *do not access the
specimen* and this artifact is that specimen's content at another path. Making that
call unilaterally would have been the wrong move even though it was my own
discipline to flag.

The decisive question is answerable from metadata alone, and the answer is
negative: its `src/` subdirectories are `agents, app, hooks, lib, lsp, mcp, memory,
policy, providers, repo, sandbox, session, skills, telemetry, tools, ui` — and
**`src/task` does not exist** (`Test-Path` → `False`). This copy is also slightly
*older* than the v0.12.0 tag (it lacks `src/presentation`).

**One lead remains unexplored and it needs your explicit go-ahead:** that
recycled `.git` has a `logs/` (reflog) and loose `objects/`. A commit created and
reset between 2026-09-25 and the wipe would leave reflog/dangling traces there
that are *not* visible in the working tree. Given everything above, I expect it to
be negative too — but it is the only remaining place the source could exist, and
checking it requires reading the specimen's content. **Say the word and I will
run `git fsck`/reflog inspection against it read-only**; I will not otherwise.

## 7. CI / build findings

No CI workspace caches, GitHub Actions artifacts, publish logs or release
archives were found. The v0.12.0 tag's `.github/` contains workflows only
(no cached artifacts ship in a repo).

## 8. Historical artifact findings

- `sessions.db.snapshot` (221 KB): **0** occurrences of `graph.ts`,
  `graph-validate`, `readiness.ts`, `TaskGraph`, `readyTasks`, `DEP_UNMET`,
  `sourceRevision`, `canExecute`.
- The five pre-wipe `*.orig.ts` artifacts (`store`, `todo`, `adapter`, `reducer`,
  `persistence`): **0** references to graph/readiness/`readyTasks`/`discover`/
  `canExecute`. The TaskGraph modules left no trace in any surviving consumer.
- **CHANGELOG `v0.12.0` — a phase-numbering trap.** Its "Phase 5" and "Phase 6"
  are labelled *"control plane"* and are about **reasoning-stream caps,
  `read_image` b64 truncation, provider env-var fallback and `watchBudgetLimit`**
  — nothing to do with tasks. The tag message "Phase 3-7" refers to that
  *output/control-plane* series. **The original project has no "Phase 5 = TaskGraph".**
  Conflating the two series would be a serious error; I record it so 5B does not.

## 9. Provenance per candidate

| candidate | classification | provenance | confidence |
|---|---|---|---|
| 7 npm tarballs ≤0.11.1 | **UNRELATED** (no `src/task/`) | registry, integrity-verified | HIGH (as a negative) |
| tag `v0.12.0` tree | **UNRELATED** (no `src/task/`) | git, 506 files | HIGH (as a negative) |
| 8 dangling commits | **UNRELATED** (recovery WIP) | git fsck | HIGH (as a negative) |
| `repo-from-remote` + 3 other MiniCode repos | **UNRELATED** | git | HIGH (as a negative) |
| `pack.json` | **REPORT-ONLY EVIDENCE** — a file *listing*, no content | local `npm pack` output | HIGH (that the files existed) |
| `store.orig.ts` relation validation | **HISTORICAL SOURCE FRAGMENT** (pre-wipe, *not* graph) | forensics | MEDIUM |
| `p77-*.ts` Scheduler API | **HISTORICAL SOURCE FRAGMENT** (Scheduler, not graph) | forensics | MEDIUM |
| recycled `$R3F30GQ` | **UNRELATED by metadata** (`src/task` absent) | Recycle Bin | LOW (objects unread) |
| 5A/5A.1 brief vocabulary (`canExecute`, `DEP_*`, …) | **REPORT-ONLY EVIDENCE** — zero occurrences anywhere | — | not admissible |

## 10. File-by-file recovery status

| file | status | source | version | hash | size | confidence |
|---|---|---|---|---|---|---|
| `src/task/graph.ts` | **NOT FOUND** | — | — | — | (9332 B per manifest) | — |
| `src/task/graph-validate.ts` | **NOT FOUND** | — | — | — | (5180 B per manifest) | — |
| `src/task/readiness.ts` | **NOT FOUND** | — | — | — | (6346 B per manifest) | — |

No partial recovery, no fragment, no hash. Nothing may be called "recovered
source" — there is no LOW-confidence reconstruction to label as such.

## 11. Confidence

**HIGH** that the files are unrecoverable *under the searched scope*: registry
(7/7 versions inspected, integrity-verified), git (tags, all commits, 8 dangling
objects, 4 other repos), caches, forensics artifacts, and the recycled specimen
copy's metadata all agree.

**Scope limits, stated honestly:**
1. No exhaustive full-disk byte scan (timed out); coverage was targeted.
2. The recycled specimen's `.git` **objects/reflog were not read** — by choice,
   pending your approval.
3. No off-machine backup, cloud snapshot or prior VM was available.

## 12. Unresolved gaps

1. **The recycled specimen's git object store** — the single unexplored lead (§6).
2. Any backup outside this machine (cloud, prior VM, external disk).
3. Whether the task subsystem was *ever* committed anywhere, even transiently.

## 13. Decision gate

# TASKGRAPH SOURCE NOT RECOVERABLE

**"Artifact recovery exhausted under current search scope."**

No TaskGraph source, no TaskGraph design, no tests, no cycle/readiness decisions.
Per §12, Phase 5B may now be framed as **TASKGRAPH NEW-DESIGN DECISION** — and
the 5A evidence stands unchanged: blocker model, `canExecute`, readiness predicate
and cycle semantics are all **UNKNOWN**, so that decision is a product decision
under explicit uncertainty, not a reconstruction.

The cheapest remaining action is your call on §6.
