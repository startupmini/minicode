# Final Reconstruction Closure

**Verdict: NO-GO** — the repository, the push, and the fresh clone are all
correct and byte-identical, but the fresh clone's test suite does **not**
reproduce the reconstruction's results. Two tests that pass in the
reconstruction fail in a fresh clone of the identical commit.

Nothing was changed to make this green.

| Item | Value |
| --- | --- |
| Final reconstruction commit | `9d79ebb56f64f044e18e223cd2a88fa862a1827` |
| Branch | `main` |
| Remote | `D:\recover\minicode-20260928\repo-from-remote` (local path, non-bare) |
| Push result | `aa76dfb..9d79ebb  main -> main` — fast-forward, no force |
| Remote HEAD (queried directly) | `9d79ebbb56f64f044e18e223cd2a88fa862a1827` |
| Old workspace handling | renamed to `D:\git\minicode-old`, preserved (4 files, 72 KB) |
| Fresh clone path | `D:\git\minicode` |
| Fresh clone HEAD | `9d79ebbb56f64f044e18e223cd2a88fa862a1827` |
| Fresh clone tree | CLEAN, 676 tracked files |
| Scheduler default | **OFF** (verified in the fresh clone) |
| Backup status | **PRESERVED** |

## 1. Why NO-GO

The reconstruction suite and the fresh-clone suite disagree at the *same
commit*, with the *same tree object*:

| | Reconstruction | Fresh clone |
| --- | --- | --- |
| full suite | 3519 pass / 23 skip / **4 fail** | 3517 pass / 23 skip / **6 fail** |
| `test/phase6ab-production-trigger.test.ts` | 32 pass / 0 fail | **1 fail** (S13) |
| `test/import-convention.test.ts` `vendor:check hijau` | pass | **fail** |

Two new failures, isolated and root-caused:

**`6AB S13: cli/index.ts forwards the parsed resumeId into createCliSession`**

```
Expected: /createCliSession\(\{[\s\S]{0,400}?\n {4}resumeId,\n/
Received: "#!/usr/bin/env bun\r\nimport { randomUUID } from \"node:crypto\"..."
```

The assertion hardcodes a bare `\n`. The fresh clone's working tree has `\r\n`,
so the regex cannot match. This is a test that reads **raw source text** and is
therefore sensitive to line endings.

**`konvensi import kernel > vendor:check hijau`**

Exit status 1 in the clone, 0 in the reconstruction. The vendor check reads
vendor files and compares their content, so the same CRLF difference flips it.

### Root cause

The committed repository is provably identical; only the *working-tree
rendering* differs.

- `git rev-parse "HEAD^{tree}"` = `5c7c98fd574fafefaafc32b33c4aea6a11813e27` in **both** repositories
- `git archive` SHA-256 = `64CA80289D66F390A532BF5BA8A008B76617B669C7AEDBE79516399B567BBCA1`, 8,540,160 bytes, in **both**
- `git ls-files` identical, 676 files each
- Committed blobs contain **0** CR bytes

But the working trees render differently, because this machine's global git
config has `core.autocrlf=true`, and `.gitattributes` declares:

```
*.ts text eol=lf
*.js text eol=lf
...
```

Despite `eol=lf`, the fresh clone checks files out with CRLF:

| File | Fresh clone CR | Reconstruction CR |
| --- | --- | --- |
| `cli/index.ts` | 620 | 0 |
| `test/phase6ad-adversarial.test.ts` | 628 | 0 |

`git diff` reports the clone as clean because git normalizes `text` files when
comparing, so **git's own tooling cannot see this**. Any tool that reads raw
bytes can.

### Why the reconstruction masked it

The reconstruction working tree is a *mix*: files I wrote directly are LF, files
git checked out are CRLF. This is visible in the repo's own lint state — biome
reports 152 format errors across `src` + `cli` in the reconstruction, all on
CRLF files:

| File (reconstruction) | CR | biome |
| --- | --- | --- |
| `src/config.ts` | 401 | FORMAT-ERROR |
| `test/web-build.test.ts` | 1221 | FORMAT-ERROR |
| `src/task/store.ts` | 0 | clean |
| `cli/commands.ts` | 0 | clean |

So the 6AD files passed lint in the reconstruction **only because they happened
to be LF there**, not because they were lint-clean by convention. In the fresh
clone every file is CRLF, so biome flags the 6AD files too (5 format errors).

The suite is therefore **not clone-reproducible**: at least two tests depend on
the working tree's line endings rather than on repository content. That directly
fails mission step 13 ("verify results are consistent with the reconstruction
workspace") and triggers the step 4 / step 19 STOP conditions.

## 2. What was verified and IS sound

Everything except the test-suite reproducibility.

**Repository integrity** — byte-identical three independent ways: tree object,
tracked-file list, and archive SHA-256 (above).

**Git state** — all three locations agree:

| Location | Branch | HEAD | Tree |
| --- | --- | --- | --- |
| reconstruction | `main` | `9d79ebb` | CLEAN |
| remote | `main` | `9d79ebb` | CLEAN |
| fresh clone | `main` | `9d79ebb` | CLEAN |

`ahead/behind = 0/0`. Local `HEAD` == `@{upstream}` == remote `refs/heads/main`.

**Push was clean** — `aa76dfb..9d79ebb main -> main`, a fast-forward with
0 commits behind, so no force was required or used. Merge-base was `aa76dfb`,
which remains reachable in history.

**Remote configuration** — the push initially could not land: the remote is a
non-bare repo with `main` checked out and `receive.denyCurrentBranch` unset, so
git would have refused. On explicit approval, `receive.denyCurrentBranch=updateInstead`
was set so the ref and the working tree advance together. The remote's tree is
CLEAN and consistent afterwards. The pre-push content of that tree is not lost —
it is `aa76dfb`, still in the fast-forwarded history.

**Typecheck** — 28 errors in the fresh clone, identical to the reconstruction
baseline. All 28 pre-date Phase 6AD; zero originate in 6AD files.

**Scheduler default OFF, verified from the fresh clone:**

- exactly one production construction call site — `cli/setup.ts:1562` (the second
  match is the function *definition* in `src/task/production-scheduler.ts:191`)
- strict gate `enabled === true ? GATE_ENABLED : GATE_DISABLED`
- default path `if (!gate.enabled) return inertHandle(gate)` — a shut gate never
  opens a DB handle, provider chain, or deletion subscription
- exactly one `fire("explicit-command")`, at `cli/commands.ts:338`
- no `process.env.*SCHED*` or `AUTO_ENABLE` activation path
- `test/phase6ac-controlled-enablement.test.ts` — 9 pass / 0 fail in the fresh clone

**Secret / artifact scan (values never printed):**

- 676 tracked files, tree CLEAN, only `node_modules/` untracked-and-ignored
- no tracked `.npmrc`, `.env`, key, certificate, database, `.m6adbak`, `.orig`, or `.rej`
- no `npm_[A-Za-z0-9]{24,}` anywhere in the tree — **the previously exposed npm token is not present at `9d79ebb`**
- no `_authToken`, no private-key blocks
- the three filename matches are all benign: `test/config-credential-audit.test.ts`
  (a test *for* credential hygiene), `test/tokens-image.test.ts` and
  `vendor/minicore/src/core/tokens.ts` (design-token / tokenizer source)
- the `sk-…` and `AKIA…` content hits are test fixtures: a redaction-scrub input
  (`"key sk-…"`) and a *negative* test asserting the bash tool **rejects** a
  leaked AWS key
- `NPM_TOKEN` in `.github/workflows/publish.yml` is a proper
  `${{ secrets.NPM_TOKEN }}` reference, not a literal

**Old `D:\git\minicode`** was never a git repository. It held only local runtime
state and was renamed, not deleted:

```
D:\git\minicode-old\.freebuff\project-id
D:\git\minicode-old\.minicode\vector.db
D:\git\minicode-old\.minicode\vector.db-shm
D:\git\minicode-old\.minicode\vector.db-wal
```

## 3. Pre-existing failures (present at clean HEAD, not caused by 6AD)

Proven by stashing all 6AD files and re-running at `0fccdce`:

- `cli: --resume > memuat riwayat sesi sebelumnya`
- `audit #11: pin vendor berlaku tanpa sibling`
- `audit #11: permukaan pack tepat`
- `§28.1 500 trigger/cycle iterations` — a 5-second **test timeout**, not a behavioural failure; flaky under load
- `web ssg > docs tanpa nested list` — scans top-level `docs/*.md`; the 6AD report is in `docs/audit/`, which it does not read

## 4. What closure requires next

This is a test-infrastructure defect, not a Scheduler or product defect, so it
does not reopen the 6AD GO verdict. It is also explicitly out of scope for this
phase, which forbids test changes. Two independent options, both requiring a new
authorisation:

1. **Make the tests EOL-independent** — the durable fix. Assertions that read
   source text should normalize line endings before matching, and the vendor
   check should hash git-normalized content. This also makes the suite portable
   to Windows checkouts generally.
2. **Make checkout honour `.gitattributes`** — investigate why
   `core.autocrlf=true` with `text eol=lf` yields CRLF on this machine, and
   correct the config or attribute set. This treats the symptom and leaves the
   brittle assertions in place.

Option 1 is recommended. The tests are the thing that is wrong: an assertion that
depends on whether a developer's machine checked out CRLF is testing the
environment, not the code.

Until one of these is authorised and verified, `D:\git\minicode` is a correct
fresh clone at the correct commit, but it is **not yet a verified reproduction**
of the reconstruction's test results.

---

BACKUP PRESERVED

`D:\git\minicode-old` is retained (4 files, 72 KB). It can be cleaned up
manually later; it was not removed.
