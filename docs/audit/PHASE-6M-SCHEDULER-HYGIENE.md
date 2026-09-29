# PHASE 6M — SCHEDULER HYGIENE + EVIDENCE INTEGRITY

Baseline commit: **`37a62b3`** (`audit: system-level validate scheduler`)
Tree at start: **CLEAN**. Branch: `main`, 38 commits ahead of `origin/main`, **nothing pushed**.

**Bounded corrective phase. Scheduler runtime semantics FROZEN and byte-verified unchanged.
This phase does NOT authorise Scheduler enablement.**

Evidence labels used throughout:
`[FACT]` executed/observed · `[OBSERVATION]` pattern seen · `[RECONSTRUCTED]` rebuilt from history ·
`[INFERENCE]` reasoned conclusion · `[DESIGN DECISION]` intentional.

---

## 1. Baseline

`[FACT]` Start state verified before any modification:

```
git status --porcelain   ->  (empty)
git log --oneline -1     ->  37a62b3 audit: system-level validate scheduler
git status -sb           ->  ## main...origin/main [ahead 38]
```

`[FACT]` The three allowed targets were reproduced from the current checkout
*before* any edit, not accepted from the 6L report.

---

## 2. D6 — Architecture map drift

### 2.1 Reproduction

`[FACT]` The gate `test/architecture-map.test.ts` line 24 asserts that every
tracked `src/**/*.ts` file appears in `docs/ARCHITECTURE.html`, matched on
**basename only** (line 28: `html.includes(f.split("/").pop())`).

`[FACT]` Reproduced by re-deriving the missing set directly from the tree
(140 tracked `src/**/*.ts`), not from the prior report:

```
MISSING: 8
  src/task/assignment.ts        src/task/readiness.ts
  src/task/graph-validate.ts    src/task/scheduler.ts
  src/task/graph.ts             src/task/session-ownership.ts
  src/task/identity.ts          src/task/sync.ts
```

`[FACT]` `src/task/` holds **10** tracked files. The two that passed the gate
(`model.ts`, `store.ts`) did so **only by substring collision** with
`presentation/model.ts`, `presentation/store.ts` and `auth-store.ts` elsewhere
in the document. The word "task" otherwise appears in the map solely in
unrelated tool names (`task.ts`, `delegateTask`, `delegate_task`).

`[INFERENCE]` The **entire** `src/task/` subsystem was unrepresented, not merely
8 files. Two escaped the gate by luck of naming.

### 2.2 Correction of 6L's attribution — 6L was wrong

`[FACT]` Measured at the pre-Scheduler baseline `99980db` (= `188e999^`), the
gate was **already failing**, with **6** missing files:

```
99980db: tracked src/**/*.ts = 138   MISSING = 6
  src/task/assignment.ts  src/task/graph-validate.ts  src/task/graph.ts
  src/task/identity.ts    src/task/readiness.ts        src/task/sync.ts
```

`[FACT]` The Scheduler programme (`188e999`, `08b105f`, `7bff3bc`, …) added
exactly **two** further offenders — `src/task/session-ownership.ts` and
`src/task/scheduler.ts` — taking the missing set 6 → 8, and never noticed
because the gate was already red.

`[INFERENCE]` **D6 is a pre-existing defect that the Scheduler era aggravated,
not one the Scheduler era created.** The 6L report attributed all 8 files to
Scheduler commits; that attribution was wrong and is corrected in place in
`PHASE-6L-SYSTEM-SCHEDULER-AUDIT.md` §4. This is a correction of *blame*, not
of severity or of any runtime result.

### 2.3 Correction applied

`[FACT]` `src/task/` was classified file-by-file from source (exports extracted
mechanically, purpose read from each file's own header comment). All 10 are
**production** architecture: no test, fixture, utility or audit-only file lives
under `src/task/`.

`[FACT]` One new `<details class="group" id="g-task">` block was added to
`docs/ARCHITECTURE.html`, placed after `src/session/` and before `src/ui/`,
matching the document's existing structure exactly (`chip c2` = L2, `role`,
`cnt` = "10 modul", one `.mod` row per file with `fname` / `fdesc` /
`exports`). No other section was touched.

`[DESIGN DECISION]` All 10 files were added, not just the 8 the gate demands.
Adding only 8 would have left the map relying on a name collision for
`model.ts`/`store.ts` — accurate-looking but false. The mission is that the map
*reflects reality*, and 10 entries is the minimum that actually does that.

`[FACT]` Every description was written from the source, including one correction
made mid-task: an initial draft described `readyTasks()` from memory as
returning a single task. Reading `src/task/graph.ts:198` showed it returns
**ids in deterministic order, or `[]` when the graph is invalid** (design lock
S10). The map text was corrected to match the code.

`[FACT]` The added block was scanned for stray non-ASCII corruption
(CJK ranges) after drafting: **0 occurrences**. Several draft descriptions had
picked up garbled fragments; all were rewritten before the block was accepted.

### 2.4 Result

`[FACT]` Missing set re-derived from the tree after the edit: **0**.
Gate: `2 pass / 0 fail` (both the file-presence test and the kernel-pin test).

---

## 3. D7 — UTF-8 BOM

### 3.1 Reproduction (byte-level)

`[FACT]` `test/phase6k-integration-safety.test.ts`:

```
size  : 30097 bytes
first : EF BB BF 2F 2F 20 50 68
BOM   : True
LF    : 663   CRLF: 0   -> LF line endings
```

`[FACT]` `git log --diff-filter=A` → the file was **added by `c671337`**
(Phase 6K itself). `[FACT]` A repo-wide scan of 599 tracked files found 3 with
a BOM: `.gitattributes`, `.gitignore`, and this test file — only the latter
trips the gate.

### 3.2 Correction applied

`[FACT]` The BOM was removed by **byte-slicing**, not by rewriting the file —
`WriteAllBytes(file, bytes[3..])`. This makes any unintended edit structurally
impossible, and is the reason for the proof below.

`[FACT]` Proof that nothing else changed:

```
payload-before SHA256 : ae6b6ef1757a500cbff9cb63902c3d5560ab18fc7f496d9dbc2bfa48364107b0
file-after   SHA256 : ae6b6ef1757a500cbff9cb63902c3d5560ab18fc7f496d9dbc2bfa48364107b0
IDENTICAL PAYLOAD   : True
size 30097 -> 30094  (delta -3)
first bytes : 2F 2F 20 50 68 61 73 65      -> "// Phase"
BOM present : False
```

`[FACT]` Line endings, test logic, assertions and whitespace are untouched by
construction.

### 3.3 Result

`[FACT]` Encoding gate green — all 3 encoding tests pass, including
*"SEMUA berkas teks terlacak tanpa BOM"*.

---

## 4. D8 — Baseline accounting

### 4.1 Method

`[FACT]` Historical states were **reconstructed from real commits**, not inferred
from memory or from any report's prose. A detached `git worktree` was created
per checkpoint and the **full suite was executed** in each.

`[FACT]` The Scheduler programme spans `188e999` → `37a62b3` (11 commits). The
pre-Scheduler baseline is `99980db` = `188e999^`.

`[FACT]` Worktree runs required a `node_modules` junction (the directory is
gitignored). This introduced one **measurement artifact**, disclosed in §4.3.

### 4.2 Historical test accounting

| Checkpoint | Total | Pass | Fail | Skip | Pre-existing | Introduced |
|---|---|---|---|---|---|---|
| `99980db` — `188e999^`, pre-Scheduler | 2928 | 2901 | **4** | 23 | 4 | 0 |
| `a94902e` — Phase 6J, pre-6K | 3056 | 3029 | **4** | 23 | 4 | 0 |
| `c671337` — Phase 6K | 3072 | 3043 | **5** | 23 | 4 | **1 (BOM)** |
| `37a62b3` — Phase 6L | 3072 | 3044 | **5** | 23 | 4 | **1 (BOM)** |
| 6M working tree (this phase) | 3072 | **3046** | **3** | 23 | 3 | **0** |

`[FACT]` The pre-existing set is identical at all four historical checkpoints:

1. `architecture-map` — every `src/**` file present in the map
2. `audit #11` — `VENDOR.md` files+hash match the tree
3. `audit #11` — shipped hash = vendor fingerprint
4. `web ssg` — docs contain no nested list

### 4.3 Disclosed measurement artifact

`[FACT]` In the worktree, `test/phase4b-isolation-lifecycle.test.ts` → *"14. MCP:
one context is stable across requests, and canonical identity works inside it"*
fails, reproducibly (2 of 2 runs). `[FACT]` It passes **8/8 in isolation, 3 runs
in a row**, and did **not** fail in the main-tree full-suite run of the same
commit.

`[INFERENCE]` It is sensitive to the worktree's `node_modules` junction, i.e. an
**artifact of the measurement apparatus, not a repository defect**. It is
excluded from the table above and disclosed here rather than quietly dropped.

`[OBSERVATION]` Consequence: pass/fail totals are not perfectly stable across
environments (`c671337` measured 3043/23/5 or 3044/23/5). Any single-run total
should carry that caveat.

### 4.4 What 6K actually got wrong

`[FACT]` 6K reported **"3045 pass / 23 skip / 4 fail — the same 4 pre-existing"**
and concluded **"No new failures."**

`[FACT]` 6K was **right** that the 4 named failures were pre-existing — the
pre-Scheduler baseline `99980db` yields the identical 4.

`[FACT]` 6K was **wrong** about the total. At its own commit the repo-state
failure count is **5**, because 6K itself added a UTF-8 BOM. The number `4` was
correct for "pre-existing" and wrong for "total", so the single failure 6K
created was invisible in its own gate table.

`[INFERENCE]` **"No new failures" is false**, and this is the precise mechanism
by which a self-inflicted regression gets normalised away: comparing the *name*
of the pre-existing set without recounting the *total*.

### 4.5 Documentation corrected

`[FACT]` `PHASE-6K-INTEGRATION-SAFETY-CORRECTIONS.md` — an **ERRATUM** section was
inserted at the baseline table. The original wording is **preserved verbatim as
the historical claim it was**; the erratum supplies the measured correction,
attributes the BOM to 6K, and states that 6K's "No new failures" is false. No
6K *finding* (D3/D4/D5) is altered or downgraded.

`[FACT]` `PHASE-6L-SYSTEM-SCHEDULER-AUDIT.md` — a superseding banner was added
at the top; the executive table now shows D6/D7 **CLOSED in 6M** and D6's
attribution corrected; §4 D6 carries an in-place correction notice; D7 is marked
closed with the hash proof; D8 was rewritten with the reconstructed numbers.

`[INFERENCE]` The correction runs in both directions: 6L's claim that D6 was
Scheduler-introduced was **overstated** and is now reduced, while 6K's claim
that it introduced no failures was **understated** and is now corrected. No
finding was moved purely to make the branch look better.

---

## 5. D5′ preservation check (regression guard only)

`[FACT]` D5′ was **not** modified. No fix was attempted, as instructed.

`[FACT]` The limitation remains documented in `PHASE-6L-SYSTEM-SCHEDULER-AUDIT.md`
§4 (D5′) and, now, additionally in the architecture map's own
`session-ownership.ts` row: *"Batas yang diketahui: dua process sistem-operasi
yang berbeda pada sesi sama TIDAK terdeteksi (audit 6L D5′ — liveness hanya ada
di memori, tak terlihat lintas proses)."*

`[FACT]` No code path was touched, so cross-process recovery behaviour is
unchanged by construction (§8).

---

## 6. Scheduler semantic freeze

`[DESIGN DECISION]` Verification by **source diff inspection and git blob hashes**,
not by tests alone, per the mission's preference.

`[FACT]` `git diff --name-only` filtered to `src/`, `cli/`, `vendor/`, `bench/`,
`scripts/` → **NONE**. No production source was modified.

`[FACT]` Every production file in the frozen surface hash-identical to `HEAD`
(`git hash-object` vs `git rev-parse HEAD:<path>`):

```
src/task/scheduler.ts            IDENTICAL
src/task/store.ts                IDENTICAL
src/task/graph.ts                IDENTICAL
src/task/readiness.ts            IDENTICAL
src/task/identity.ts             IDENTICAL
src/task/sync.ts                 IDENTICAL
src/task/assignment.ts           IDENTICAL
src/task/session-ownership.ts    IDENTICAL
src/task/model.ts                IDENTICAL
src/task/graph-validate.ts       IDENTICAL
src/session/persistence.ts       IDENTICAL
```

`[FACT]` Therefore, specifically unchanged: claim semantics, `exec_generation`
semantics, `attempt_generation` semantics, the reconciliation predicate, the
active-claim exemption, the readiness gate, completion authority, and session
deletion ordering.

### Explicit statement

> **scheduler runtime semantics: BYTE-UNCHANGED.**
> All 11 production files in the frozen surface are byte-identical to `37a62b3`,
> verified by git blob hash. `src/task/scheduler.ts` was not opened for edit at
> any point in this phase. No production file was touched, so the stronger
> "byte-unchanged" claim **is** supported by evidence and is used instead of the
> weaker "behaviourally unchanged".

`[FACT]` Scheduler remains disabled: `new Scheduler(` occurs in `src/` only
inside a comment (`src/task/scheduler.ts:29`).

---

## 7. Gate results

| Gate | 6L baseline | 6M result | Verdict |
|---|---|---|---|
| `tsc --noEmit` | 28 errors | **28 errors** | unchanged, 0 new |
| lint `src/task` | 7 errors | **7 errors** | unchanged, 0 new |
| lint full scope | (not recorded) | 433 errors / 7 warnings | `[OBSERVATION]` pre-existing; none in 6M-changed files |
| biome on BOM-fixed file | — | **0 errors** (4 infos) | no new |
| **encoding gate** | **FAIL (D7)** | **PASS** (3/3) | **CLOSED** |
| **architecture-map gate** | **FAIL (D6)** | **PASS** (2/2) | **CLOSED** |
| targeted suites (12 files) | — | **328 pass / 0 fail** | no regression |
| **full suite** | 3044/23/**5** | **3046 / 23 / 3** | 2 gates fixed, 0 new failures |

`[FACT]` Targeted suites: `phase5-taskgraph`, `phase6b-prerequisites`,
`phase6c-scheduler`, `phase6f-attempt-recovery`, `phase6k-integration-safety`,
`task-di`, `task-invariants`, `taskstore`, `sync`, `phase3a-identity`,
`phase4a4-production-sync`, `phase4b2-production-sync-atomicity`.

`[FACT]` The 3 remaining full-suite failures are **exactly** the 3 verified
pre-existing ones. `[INFERENCE]` No new failure was introduced, and none was
normalised away: the count went **down** by 2 precisely because two gates were
repaired, and the residue matches the pre-Scheduler baseline minus the
architecture-map entry that 6M closed.

---

## 8. Mutation / fault evidence (gate self-verification)

`[FACT]` No artificial production mutants were created.

**K6M-1 — CONFIRMED.** Renamed the map entry `scheduler.ts` →
`scheduler-REMOVED.ts`; the architecture-map gate **failed**. File restored from
a byte backup; SHA-256 `a14fcd5332c41862…` identical before and after. The gate
is neither vacuous nor weakened.

**K6M-2 — CONFIRMED.** Re-prepended `EF BB BF` to the BOM-fixed test file; the
encoding gate **failed** (*"SEMUA berkas teks terlacak tanpa BOM"*). File
restored; SHA-256 `ae6b6ef1757a500c…` identical before and after.

**K6M-3 — NO AUTOMATED VERIFICATION EXISTS.** The mission asked whether altering
the corrected baseline-accounting evidence would be detected "where automated
verification exists". `[FACT]` It does not. No test reads
`PHASE-6K-INTEGRATION-SAFETY-CORRECTIONS.md`, `PHASE-6L-SYSTEM-SCHEDULER-AUDIT.md`
or any `docs/audit/*.md`. The only matches for those filenames in `test/` are
two **comments** in `phase2-addressing.test.ts:15` and
`phase3b-plan-pipeline.test.ts:9`.

`[INFERENCE]` This is exactly the gap that let D8 happen: the architecture map
and file encodings are machine-enforced, but **factual claims inside audit
reports are enforced only by discipline**. D8 was a wrong number in a report, and
no gate in this repository would ever have caught it. Recorded as a limitation
below rather than fixed, since adding a report-consistency gate is outside the
allowed scope of 6M.

---

## 9. Diff summary

`[FACT]` Four **tracked** files changed, +93 / −12, plus this new report:

| File | Change | Class |
|---|---|---|
| `docs/ARCHITECTURE.html` | +16 | D6 correction — new `g-task` group, 10 modules |
| `test/phase6k-integration-safety.test.ts` | −3 bytes | D7 correction — BOM only, payload SHA-256 unchanged |
| `PHASE-6K-INTEGRATION-SAFETY-CORRECTIONS.md` | +42 | D8 — erratum, original claim preserved |
| `PHASE-6L-SYSTEM-SCHEDULER-AUDIT.md` | +45/−12 | D6 attribution correction, D7 closed, D8 numbers |
| `docs/audit/PHASE-6M-SCHEDULER-HYGIENE.md` | new | this report |

`[FACT]` Production diff specifically: **empty**. `src/`, `cli/`, `vendor/`,
`bench/`, `scripts/` all untouched.

---

## 10. Remaining limitations

Carried forward unchanged from 6L — **none** was addressed in 6M, by design:

1. `[DESIGN DECISION]` Crash between a `runTurn` return and the lineage write can
   cause one duplicate execution.
2. `[DESIGN DECISION]` Model/task intent remains unprovable — the Scheduler
   cannot know whether a turn accomplished the task.
3. `[DESIGN DECISION]` **D5′** cross-process same-session ownership unsupported;
   a foreign process recovers a live task. Reproduced with two real processes.
4. `[DESIGN DECISION]` No verifier component exists.
5. `[DESIGN DECISION]` No attempt history is recorded.
6. `[FACT]` **Newly recorded by 6M:** audit-report factual claims are not
   machine-verified (§8, K6M-3).
7. `[FACT]` 3 pre-existing failures remain (2× `VENDOR.md` fingerprint, 1×
   `web ssg` nested list). They predate the Scheduler programme and are out of
   6M scope.
8. `[FACT]` `RETRYING` remains a declared-but-unwritable, inert status (6L I1).
9. `[OBSERVATION]` Suite totals vary by ±1 with test environment (§4.3).

---

## 11. Final verdict

# GREEN — hygiene/evidence corrections complete

| Criterion | Status |
|---|---|
| D6 closed | **YES** — architecture-map gate green, 0 missing |
| D7 closed | **YES** — encoding gate green, BOM gone, payload hash identical |
| D8 corrected + historically evidenced | **YES** — 4 real commits measured, erratum filed |
| architecture-map gate GREEN | **YES** (2/2) |
| encoding gate GREEN | **YES** (3/3) |
| no new runtime regression | **YES** — 3046/23/3; 3 failures all verified pre-existing |
| Scheduler production semantics unchanged | **YES** — 11/11 files byte-identical |
| `RETRYING` / I1 left as documented | **YES** |
| D5′ not fixed, still documented | **YES** |
| Scheduler still disabled | **YES** — 0 production construction |
| nothing pushed | **YES** |

`[INFERENCE]` The measurement apparatus is now trustworthy in the two places it
was not: the architecture map reflects the tree, and the repository is
BOM-free with the encoding gate enforcing it. The one place it remains
untrustworthy is factual claims inside audit prose, which nothing enforces —
and which, in this phase, required me to correct **my own** 6L attribution in
the same document I had authored one commit earlier.

### What GREEN does not mean

> **This does NOT authorise Scheduler enablement.** GREEN here means the
> hygiene and evidence defects are closed and the measurement apparatus is
> sound. The runtime limits in §10 — duplicate window, unprovable intent, D5′
> cross-process recovery, no verifier, no attempt history — are all still open
> by design. Enablement is a separate decision requiring separate evidence.
