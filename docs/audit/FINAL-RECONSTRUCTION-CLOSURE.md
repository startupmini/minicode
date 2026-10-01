# Final Reconstruction Closure

**FINAL RECONSTRUCTION: CLOSED**
**REMOTE: CANONICAL SOURCE OF TRUTH**
**FRESH CLONE: SEMANTICALLY REPRODUCIBLE**

| Item | Value |
| --- | --- |
| Corrective commit | `ee177f0d9d109eefe65e58736dc206762373f644` |
| Predecessor (6AD) | `9d79ebb56f64f044e18e223cd2a88fa862a1827` |
| Branch | `main` |
| Remote | `D:\recover\minicode-20260928\repo-from-remote` |
| Push | `9d79ebb..ee177f0 main -> main` — fast-forward, no force |
| Canonical vendor hash | `c8d214bb8d5eea86` (20 files) |
| Canonical shipped hash | `78768e71a45254c3` (18 files) |
| `D:\git\minicode` | HEAD `ee177f0`, tree CLEAN |
| Preserved backup | `D:\git\minicode-old` (4 files, 72 KB) |

---

## 1. `9d79ebb` was Git-identical but not semantically reproducible

This is the part of the history that must not be rewritten. At `9d79ebb` the
repository was byte-identical across all three locations — tree object
`5c7c98fd574fafefaafc32b33c4aea6a11813e27`, 676 tracked files each, `git archive`
SHA-256 `64CA80289D66F390A532BF5BA8A008B76617B669C7AEDBE79516399B567BBCA1` at
8,540,160 bytes. And it still failed its own test suite in a fresh clone:

| | reconstruction (mixed EOL) | fresh clone (`autocrlf=true`) |
| --- | --- | --- |
| full suite | 3519 pass / 23 skip / **4 fail** | 3517 pass / 23 skip / **6 fail** |
| `phase6ab-production-trigger` | 32 pass | **1 fail** |
| `import-convention` `vendor:check` | pass | **fail** |

Git reported the working tree CLEAN in both. The divergence was invisible to
`git diff`, because git normalizes `text` files when comparing and the affected
tools read raw bytes.

The root cause is that committed blobs are LF-only (`.gitattributes` sets
`*.ts text eol=lf`) while a Windows checkout with `core.autocrlf=true` rewrites
them to CRLF:

| File | committed blob | fresh clone (CRLF) | reconstruction |
| --- | --- | --- | --- |
| `cli/index.ts` | 27,851 B, 0 CR | 28,471 B, 620 CR | 0 CR |
| `src/config.ts` | — | 401 CR | 0 CR |
| `test/phase6ad-adversarial.test.ts` | 0 CR | 628 CR | 0 CR |

The reconstruction's working tree was a *mix* — files written during the audit
were LF, files git checked out were CRLF — which is why the repo already carried
152 biome format errors on the CRLF files while the freshly written 6AD files
lpassed. That accident is why the defect stayed hidden, and it is not a property
anyone should rely on.

## 2. Two independent defects

### 2.1 EOL-sensitive semantic assertion (test defect)

`test/phase6ab-production-trigger.test.ts` S13 matched source text with a
pattern requiring a bare LF:

```
Expected: /createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/
Received: "#!/usr/bin/env bun\r\nimport { randomUUID } from \"node:crypto\"..."
```

The wiring it verifies was correct on both machines. The fix normalizes line
endings first, via `test/helpers/source-eol.ts`. **The assertion is unchanged** —
it still requires the shorthand `resumeId,` at four-space indent, the exact shape
mutation M11 destroys.

### 2.2 Raw-byte hashing in vendor verification (script defect)

`scripts/vendor-minicore.ts` hashed raw file bytes, so `vendor:check` reported
drift for a tree identical apart from line endings:

```
source raw (LF)   : 840aa2e9cd70a401  = the value recorded in VENDOR.md
vendor raw (CRLF) : 3f027ea6d8f1b18e  <- mismatch reported as drift
both normalized   : c8d214bb8d5eea86  <- identical
files differing after EOL normalization: 0 of 20
```

Worse, `test/pack-integrity.test.ts` contained a *third* copy of the same
raw-byte algorithm. Three implementations of one integrity contract, none able
to see the others, all reporting different answers.

### 2.3 The stale pin, and why VENDOR.md was regenerated

The pin `840aa2e9cd70a401` was recorded under the old raw-byte algorithm. The
tree it protects is correct — the recorded source commit `0d33571` matches the
sibling `D:\git\minicore` HEAD exactly, and zero files differ after EOL
normalization. The **pin was stale, not the vendored code**.

Under the amended contract the correct value is `c8d214bb8d5eea86`. The file
says `JANGAN EDIT MANUAL`, so it was not hand-edited: `bun run vendor:minicore`
was run and the generator rewrote it. That run also produced the clearest
demonstration that sync semantics were preserved — it copied raw bytes, so 18
files were rewritten on disk with the source's own line endings while git
reported **zero** content changes (`git diff --numstat` empty). Only the single
`VENDOR.md` hash line is a real content change.

## 3. One canonical contract, not three

The rule now lives once, in `test/helpers/vendor-hash.ts`:

- **text** — `CRLF` → `LF`, then bare `CR` → `LF`
- **binary** — raw bytes, behind a NUL-byte gate (git's own 8000-byte heuristic)

Nothing is trimmed, re-indented, Unicode-normalized, or BOM-altered. The sync
path still copies raw bytes; only hash *comparison* is normalized. The
vendoring scope (`INCLUDE_DIRS`, `INCLUDE_FILES`, `SHIPPED_EXCLUDE`), the
no-sibling branch, the refuse-to-clobber-empty behaviour, and the `--check`
branching are all unchanged.

`test/pack-integrity.test.ts` and `scripts/vendor-minicore.ts` both call the
shared helper. Verified: `git diff` contains no second algorithm.

## 4. Invariants proven

Driving the **actual** `scripts/vendor-minicore.ts` through its
`MINICODE_MINICORE_SOURCE` seam, with a full 20-file source tree:

| Scenario | Expected | Result |
| --- | --- | --- |
| LF source, no drift | in sync | exit 0, `c8d214bb8d5eea86` |
| CRLF source, no drift | in sync | exit 0, `c8d214bb8d5eea86` |
| LF source, one character changed | drift | exit 1, `a8f3cdf35fde27b1` |
| CRLF source, one character changed | drift | exit 1, `a8f3cdf35fde27b1` |

EOL representation is invisible; content drift is not. Binary payloads with one
differing byte hash differently, and `vendor/minicore` is confirmed text-only
(0 NUL bytes across all 20 files), so the binary gate is a documented safeguard
rather than an active path.

## 5. Mutation campaign

`scripts/phase6ae-vendor-mutation.ts` — 6 mutants, **5 KILLED, 1 EQUIVALENT, 0
UNEXECUTED**, all against the canonical helper and its real callers.

| Mutant | Status | Killed by |
| --- | --- | --- |
| M1 EOL normalization removed | KILLED | CRLF/LF equivalence test |
| M2 last byte of every file discarded | KILLED | `LAST character changes the hash` |
| M3 NUL/binary gate disabled | KILLED | 3 binary tests |
| M4 hash comparison always succeeds | KILLED | 5 drift tests |
| M5 sync path normalizes EOL on copy | EQUIVALENT | — |
| M6 pack-integrity reintroduces raw hashing | KILLED | pack-integrity under CRLF |

M5 is genuinely equivalent: the sync path is not observable through a
normalizing hash gate. Raw-copy behaviour is verified separately by
fingerprint (`vendor bytes == sibling bytes → true`), and that property is
stated in the mutant's note rather than left implied.

Two campaign harness defects were found and fixed during this phase, both worth
recording because they produced false confidence:

1. **A leftover mutation fooled the restoration audit.** One run left M5 on
   disk. The next run snapshotted that already-mutated file as its "pre-campaign"
   baseline, applied M5 as a no-op, "restored" the mutated file to itself, and
   reported `byte-identical` — so M5 came back as EQUIVALENT while the code
   under test was broken. A check that compares state to its own baseline
   cannot detect a bad baseline. The campaign now refuses to start unless every
   target matches HEAD, and the guard was proven by planting a mutation and
   observing exit 2.
2. **PowerShell corrupts bytes.** `| Set-Content` turned an 8,211-byte file into
   8,457. All file operations in this phase go through Bun.

## 6. LF / CRLF matrix

Two clean clones of the same remote commit, differing only in checkout EOL:

| | clone A (`autocrlf=true`) | clone B (`autocrlf=false`) |
| --- | --- | --- |
| HEAD | `ee177f0` | `ee177f0` |
| worktree clean | yes | yes |
| `cli/index.ts` CR | 620 | 0 |
| `vendor/minicore/src/core/index.ts` CR | 41 | 0 |
| `vendor:check` | exit 0 | exit 0 |
| S13 suite | 32 pass / 0 fail | 32 pass / 0 fail |
| pack-integrity | 9 pass / 0 fail | 9 pass / 0 fail |
| vendor-hash contract | 14 pass / 0 fail | 14 pass / 0 fail |
| vendor EOL | 9 pass / 0 fail | 9 pass / 0 fail |
| EOL helper | 13 pass / 0 fail | 13 pass / 0 fail |
| import-convention | 12 pass / 0 fail | 12 pass / 0 fail |
| **full suite** | **3557 pass / 23 skip / 2 fail** | **3557 pass / 23 skip / 2 fail** |

Identical commit, different checkout EOL, identical semantic result. Working-tree
bytes are *not* identical, and are not required to be.

## 7. Full gates

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | 28 errors — all pre-existing at 6AD, **0** in 6AE files |
| `biome` on the 9 6AE files | clean |
| `bun run lint` (repo-wide) | exits 1 — **fails identically at HEAD**, pre-existing |
| architecture-map + repomap | 8 pass / 0 fail |
| Mutation campaign | 5 KILLED, 1 EQUIVALENT, 0 UNEXECUTED |
| Full suite | 3557 pass / 23 skip / 2 fail |

### The two remaining failures

Both were proven pre-existing by stashing all 6AE work and re-running at
`9d79ebb` — both fail there too:

- **`§28.1 500 trigger/cycle iterations`** — `this test timed out after 5000ms`.
  A 5-second timeout on a machine-speed-dependent loop, not a behavioural
  failure. Unrelated to EOL and to vendor hashing.
- **`web ssg > docs tanpa nested list`** — scans top-level `docs/*.md` for
  indented list markers. 6AE adds nothing under `docs/`; the file does not
  reference any 6AE artifact. Pre-existing doc formatting, not a test regression.

Nothing was reclassified as "pre-existing" without a reproduction.

## 8. Production runtime frozen

`git diff -- src cli` is **empty** at `ee177f0`. Verified unchanged:
`src/task/scheduler.ts`, `store.ts`, `task-graph.ts`, `trigger.ts`,
`autonomous-context.ts`, `session-ownership.ts`, `autonomous-policy.ts`,
`production-scheduler.ts`, `scheduler-observability.ts`, `src/app/session.ts`,
`cli/setup.ts`, `cli/commands.ts`, `cli/tui.ts`, `cli/index.ts`.

The only non-test change is `scripts/vendor-minicore.ts` (tooling, authorized) plus
the `VENDOR.md` its own generator produced. Scheduler semantics, TaskStore,
TaskGraph, permissions, lease, and trigger are untouched.

Scheduler default remains **OFF**: one production construction site
(`cli/setup.ts:1562`), strict `enabled === true` gate, `inertHandle` when shut,
one `fire("explicit-command")` at `cli/commands.ts:338`, no environment or
automatic activation path.

## 9. Secret and artifact scan

- 676 tracked files; tree CLEAN; only `node_modules/` untracked-and-ignored
- no tracked `.npmrc`, `.env`, key, certificate, database, `.m6adbak`, `.orig`, `.rej`
- **no `npm_[A-Za-z0-9]{24,}` anywhere in the tree** — the token exposed during
  the earlier registry investigation is not present at `ee177f0`
- the `sk-…` and `AKIA…` matches are test fixtures: a redaction-scrub input and
  a *negative* test asserting the bash tool rejects a leaked AWS key
- `NPM_TOKEN` in `.github/workflows/publish.yml` is `${{ secrets.NPM_TOKEN }}`,
  a reference, not a literal

## 10. Commit

```
ee177f0  fix: make repository verification EOL independent
  10 files changed, 1066 insertions(+), 50 deletions(-)
```

Single commit. `VENDOR.md` was generated, not hand-edited. Pushed fast-forward;
`HEAD == upstream == remote main == ee177f0`; `D:\git\minicode` CLEAN.

## 11. Preserved backup

`D:\git\minicode-old` — retained, not deleted. It was never a git repository and
holds only local runtime state: `.freebuff/project-id` and
`.minicode/vector.db` (+ `-shm`/`-wal`, 72 KB total). It can be cleaned up
manually later.

## Reproducing

```
bun test test/phase6ae-vendor-hash.test.ts test/phase6ae-vendor-eol.test.ts \
           test/phase6ae-source-eol-helper.test.ts test/pack-integrity.test.ts
bun run scripts/phase6ae-vendor-mutation.ts
bun run vendor:check
bun test
```

Clone reproducibility: clone the remote twice with
`git -c core.autocrlf=true clone …` and `git -c core.autocrlf=false clone …`, then
run the same gates. Both must agree. No global Git configuration is required or
modified.
