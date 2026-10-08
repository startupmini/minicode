# LEGACY WORKSPACE FORENSIC AUDIT

Audit-only. Read-only. No fix, no delete, no move, no commit, no env change.
Auditor working directory during audit: `D:\recover\minicode-20260928\reconstruction` (itself evidence — §13).
Date: 2026-10-08. All commands non-mutating (`rev-parse`, `status`, `ls-files`, `show`,
`Get-Item`, `Get-Content`, `Select-String`, read-only SQLite open, process-table read).

## 1. Executive Summary

The agent keeps working in the legacy workspace **not because any code, config, or git
metadata redirects it there**, but because **OpenCode Desktop persists per-workspace
session state and the live sessions (including this audit session) are bound to the
legacy path**. Two recorded decisions inside OpenCode's own UI state name the legacy
path as current: the handoff tab (`.../reconstruction`, session `ses_eea0...`) and
`home.selection.directory = D:\recover\minicode-20260928\reconstruction`
(`opencode.window.*.dat`, 07/10 17:51). A legacy workspace blob holding the auditor's
own sessions was updated today 06:33/09:12. This is **REFERENCE + MEMORY + WORKSPACE
authority**, not git authority: both clones are healthy independent repos, canonical is
19 commits ahead and in sync with its remote, and no operational code in canonical
references the legacy path (only historical report headers do).

Two further structural dependencies keep legacy alive: (a) **both clones' git `origin`
is a local-path repo physically inside the legacy tree**
(`D:\recover\minicode-20260928\repo-from-remote`) — deleting the legacy directory
breaks fetch/push for the canonical clone too; (b) **active development diverged** —
canonical advanced P1/P2 (01–07/10) while legacy accumulated uncommitted M1 + P3.2 work
plus live `.minicode` state (07–08/10), so there is real unmigrated work, not just stale
memory.

Migration is therefore **not complete**: code HEAD migrated, work state did not.

## 2. Canonical Workspace Verification

- Path `D:\git\minicode`: normal directory, **normal clone** (not worktree/junction/symlink/mount).
  `.git` is a real hidden directory; `git-dir == git-common-dir == .git`; prefix empty;
  single worktree (itself); no alternates (independent object store).
- Branch `main`; HEAD `e284298a7a177ce29f98f403585fcc085cb8c89f`
  (`chore(p2): close session architecture and handoff to phase 3`, 2026-10-07 00:30 +0700).
- **HEAD ≠ brief's `9d79ebb`**: `9d79ebb` is an ancestor, 19 commits back. The brief's
  "verified state" is stale by 19 commits / 6 days.
- Remote `origin = D:\recover\minicode-20260928\repo-from-remote` (local path, fetch+push).
  `origin/main == HEAD`; `status -sb` shows `## main...origin/main` with no ahead/behind:
  **in sync with its remote**. No unstaged/untracked files; 5 index-only staged additions
  (`P3.10_GATE_HYGIENE_CLOSURE_REPORT.md`, `P3.1_IMPLEMENTATION_REPORT.md`,
  `P3_0_CONTEXT_SESSION_CONTRACT.md`, `P3_FORENSIC_AUDIT_REPORT.md`,
  `test/p3-reconciliation-guard.test.ts`) — `git add` without commit, present in index,
  absent from HEAD, no stash.
- 778 tracked files.

## 3. Legacy Workspace Verification

`D:\recover\minicode-20260928\reconstruction` **is a full independent git clone**
(real directory + real hidden `.git` dir, own worktree, no alternates, no gitdir
indirection): branch `main`, HEAD `9d79ebb` (2026-10-01 12:34 +0700), remote = same
local-path `repo-from-remote`. Tracking ref `origin/main` is stale at `9d79ebb`
(never fetched since; remote HEAD is now `e284298`). Working tree: 2 modified
(`src/presentation/events.ts`, `src/session/journal.ts` — uncommitted M1 hunk) + 8
untracked entries (M1 files, P3.2 module/test/report, M0 baseline report, closure doc).
676 tracked files. Parent `D:\recover\minicode-20260928\` also holds `repo-from-remote/`,
`parseout/`, and 28/09 recovery-operation artifacts (USN/OS forensic reports, logs) —
the directory is the recovery-operation site, not just a repo folder.

## 4. Git Topology

```text
GitHub startupmini/minicode (network; state not probed — read-only, no fetch)
  ↑ fetch-only relationship (75 commits behind per tracking ref; RECOMMENDED: owner verifies)
  D:\recover\minicode-20260928\repo-from-remote  [non-bare, HEAD=e284298, main, tree CLEAN,
     origin=GitHub URL, receive.denyCurrentBranch=updateInstead]
  ↑ local-path origin (BOTH clones) — lives INSIDE the legacy tree
  ├── D:\git\minicode            [HEAD=e284298, in sync, +5 staged uncommitted]
  └── D:\recover\...\reconstruction [HEAD=9d79ebb + uncommitted work, tracking ref stale]
```

No worktrees, no submodules, no alternates, no shared object DB. Global `~/.gitconfig`
clean (identity + LFS + credential helper only; no `insteadOf`, no legacy refs).
Answer to Phase 9: **git does not consider legacy part of any worktree topology**; but
both clones' `origin` URL hard-codes the legacy-tree path — an operational dependency
on the directory's existence (fetch/push break if it disappears), not a topology link.

## 5. Canonical vs Legacy Comparison

| Dimension | Canonical (`D:\git\minicode`) | Legacy (`.../reconstruction`) | Class |
|---|---|---|---|
| HEAD | `e284298` (07/10) | `9d79ebb` (01/10), ancestor, 19 behind | DIFFERENT (canonical newer) |
| Tracked files | 778 | 676 | DIFFERENT |
| Canonical-only tracked (102) | P1-M1..M16 + P2.10–2.12 (`src/daemon/*`, `src/runtime/*`, `cli/commands/daemon.ts`), P1/P2/EOL reports, closure doc committed | — | CANONICAL ONLY |
| Legacy-only tracked | — | none (0) | SAME (superset) |
| `src/runtime/execution-id.ts` | committed (p1-m1) | untracked, **byte-identical** (SHA 5A40F5A4…) | SAME content, redundant copy |
| `test/execution-id.test.ts` | committed | untracked, **byte-identical** (SHA 607B0433…) | SAME content, redundant copy |
| `events.ts` / `journal.ts` M1 fields | committed + P1/P2-evolved (12 `executionId?` hits, 6 ADR-002 markers) | uncommitted hunk on 9d79ebb (same counts) | DIFFERENT files, same feature |
| P3.2 `context-identity.*` | absent | untracked, legacy-only work | LEGACY ONLY (migration candidate) |
| `FINAL-RECONSTRUCTION-CLOSURE.md` | committed under `docs/audit/` | untracked copy (byte-compare inconclusive — EOL/encoding; needs normalized check) | UNKNOWN, verify |
| 5× P3.x staged files | index-only (uncommitted) | absent | CANONICAL ONLY (uncommitted) |
| `.minicode` activity | live (journals+sessions.db+tasks.db 07/10 16:47) | live (journals+MEMORY+vector **today 08/10** 07:30–07:45) | BOTH ACTIVE |
| `.git` | independent, healthy | independent, healthy | SAME kind |

Semantic direction: canonical is authoritative for committed code; legacy holds the only
copies of P3.2 work + today's execution traces. Neither is disposable without review.

## 6. Repository Search Findings

Search for `D:\recover`, `D:/recover`, `repo-from-remote`, `minicode-20260928` across
canonical (tracked + hidden, excluding `node_modules` bulk): **all 99 hits are in
historical `*.md` reports** (`Workspace: D:\recover\...` headers written while that work
ran in legacy; closure docs naming the remote). **Zero hits in code, config, scripts,
workflows, skills, or IDE files.** Classification: HARMLESS HISTORICAL REFERENCE, not
runtime relevance. The one operational legacy-path reference in canonical is git
metadata itself: `.git/config` `remote.origin.url` (§4) — CONFIGURATION authority for
fetch/push only. Legacy `.minicode` journals embed the legacy cwd per record
(execution-local history, §12); canonical journals embed the canonical cwd. No
cross-contamination found.

## 7. Global Environment Findings

`%USERPROFILE%`: no `.opencode`, no recovery-named dirs; `.config/opencode/` holds only
providers/MCP config (`opencode.jsonc` — **no workspace or default-directory key**).
No `%APPDATA%\Code` (VS Code not installed). No PowerShell profiles (all four standard
paths absent). Env vars: **no MINICODE/WORKSPACE/PROJECT/RECOVER/etc. variables**;
nothing references either repo path (only trivial `SESSIONNAME=Console`, `SystemRoot`
regex collisions). `~/.config` agent-ish dirs (`cagent`, `manicode`, `mimocode`,
`muse`, `freebuff-desktop`) exist but the active agent is OpenCode Desktop (§8); not
probed deeper (out of chain). Conclusion: user profile carries **no legacy pointer**;
workspace selection is not coming from shell, env, or global agent config.

## 8. Agent Configuration Findings

Agent in use: **OpenCode Desktop** (`@opencode-aidesktop`), GUI-launched from Explorer.
Proven invocation chain (read-only process table, PIDs observed live):

```text
explorer.exe (9392)
 └─ OpenCode.exe (16756, bare cmdline = Electron main)
     └─ OpenCode.exe (17716, --type=utility --utility-sub-type=node.mojom.NodeService,
                      --user-data-dir=...\AppData\Roaming\ai.opencode.desktop)
         └─ powershell.exe (tool shell of this audit session)
```

`opencode.jsonc` = providers + one MCP entry only — no workspace pinning. The workspace
decision therefore lives in OpenCode's per-window UI state (§11), not in launcher,
CLI args (none), config files, or shell.

## 9. Launcher / Shell Findings

Start Menu `OpenCode.lnk`: target = installed `OpenCode.exe`, **no arguments**,
workdir = install dir. No `.cmd`/`.bat`/`.ps1` wrappers found; no `cmd` autorun
evidence sought beyond profiles (absent). Shell is a spawned tool pipe
(`-NoLogo -NoProfile -NonInteractive`), inheriting cwd from the agent session, not
choosing it. **Launcher is clean** — it does not and cannot inject the legacy path.

## 10. IDE Findings

No VS Code / Cursor / Claude-Code / Gemini IDE integration present (no app, no
`.vscode/.cursor/.claude/.codex/.gemini` in either repo). In this environment
**OpenCode Desktop is the IDE**: it owns window layout, file-tree/sidebar state,
session tabs, and the home directory selector. IDE association therefore увековечен in
`%AppData%\Roaming\ai.opencode.desktop\opencode.window.*.dat` and
`opencode.workspace.*.dat` (§11), nowhere else. No repo-local IDE files to migrate.

## 11. Agent Memory / Session Findings

`ai.opencode.desktop` keeps **per-workspace blobs**; filename encodes the path
(plain prefix `D--git-minic…` / `D--recover-m…` or base64 `RDpc…` = `D:\git\…`,
`RDpccmVjb3Zl…` = `D:\recover…`, verified by decoding). Session records are keyed
`local\u0000<base64-path>/<session-id>` — i.e. **sessions are permanently bound to the
workspace path they were created in** (persistent, authoritative for the UI; read by the
app on launch/restore). Decisive records:

- `opencode.workspace.D--recover-m.hc4dxu.dat` (updated **today 06:33**) holds sessions
  `ses_f08c93…` + `ses_eea0b5…` with model `muse-spark-1.3-contributor-free` — the
  auditor's own model/session family. Same sessions appear in `RDpccmVjb3Zl…dat`
  (updated **today 09:12**, this session's lifetime).
- `opencode.workspace.D--git-minic.1m8r3m3.dat` (06/10) holds a *different* session
  (`ses_eff4ce…`, other model) — canonical path is known to the app, but the live
  sessions live under the legacy key.
- `opencode.window.6fc96….dat` (07/10 17:51): `"handoff":{..."dir":"<b64 legacy
  reconstruction>","id":"ses_eea0b5…"}` and `"home":{"selection":{"server":"sidecar",
  "directory":"D:\\recover\\minicode-20260928\\reconstruction"}}`.

So: remembered workspace = legacy (persistent UI state); session↔workspace binding =
by construction (key design, not corruption). No in-memory-only or derived ambiguity —
this is the persisted source the app restores.

## 12. MiniCode State Findings

- Canonical `.minicode`: 141 sessions in `sessions.db`, **all with empty `cwd`**
  (read-only aggregate query) — minicode's own store binds no workspace path
  (execution-local, non-authoritative). Journals record the run's cwd
  (`D:\git\minicode`) — historical, per-record.
- Legacy `.minicode`: `sessions.db` has **0 rows**; activity is journals + `MEMORY.md` +
  `vector.db` (today). Journals record legacy cwd per record — same historical class.
- `MEMORY.md` in both: no absolute paths. No repo-map/checkpoint/shadow-git absolute-path
  binding found. **Minicode internal state does not anchor the agent to either path**;
  it merely records where each run happened. Classification: DERIVED/HISTORICAL.

## 13. Startup / Bootstrap Trace

```text
PROCESS START: explorer double-click → OpenCode.exe (no args, no workspace)
  input: none · output: app window · authority: OS launcher (clean, §9)
CWD: install dir (link workdir); irrelevant — app does not use process cwd for workspace
workspace discovery: reads ai.opencode.desktop state
  → home.selection.directory = LEGACY path        ← INJECTION POINT (persisted UI state)
  → session tabs keyed by base64 workspace path; handoff session bound to LEGACY
  authority: OpenCode UI state (persistent, §11)
Git discovery: per-workspace: legacy→9d79ebb+dirty; canonical→e284298+staged
  authority: each clone's own .git (both healthy; neither redirects)
configuration loading: opencode.jsonc (providers only — no path keys)
agent memory loading: workspace.*.dat blobs (legacy blob updated today)
repo-map / session restore: session IDs resolve under legacy key
context assembly: tool shell spawned with cwd = LEGACY (observed: this session)
```

First stage where legacy enters: **workspace discovery from persisted UI state**.
Nothing upstream (launcher/shell/env/config/git) contributes a legacy reference.

## 14. Fallback Analysis

Searched minicode + repo for fallback/recovery/previous/backup/restore/legacy/snapshot
semantics touching workspace choice: minicode's fallbacks (busy-retry, degraded-loud
journal, resume-verify-first, `INSERT OR IGNORE`) are **storage/commit-level**, none
select a workspace; none names the legacy path. The operational "fallback" is
**session restore**: reopening/continuing a legacy-bound session re-presents the legacy
workspace with no explicit fallback logic — legitimate UX mechanism, legacy residue in
effect. Git-side: local-path `origin` is not a fallback but a hard dependency (§4).
No unsafe automatic workspace switching found. Classification: session-restore =
legitimate mechanism with legacy content; no unsafe fallback.

## 15. Path Injection Point

`home.selection.directory` + session-keyed workspace blobs in
`%AppData%\Roaming\ai.opencode.desktop\` — specifically
`opencode.window.6fc96….dat` (handoff dir + home selection, 07/10) and
`opencode.workspace.D--recover-m.hc4dxu.dat` / `RDpccmVjb3Zl.v5gqzj.dat` (today).
The legacy path enters the system **at OpenCode Desktop's workspace/session restore**,
before any repo tooling runs. Nothing in `D:\git\minicode`, git metadata, env, shell,
or launcher injects it.

## 16. Path Authority Graph

```text
User opens D:\git\minicode (intent)
  ↓ (GUI launch, no args)
OpenCode.exe main → utility NodeService (ai.opencode.desktop profile)
  ↓ reads persisted UI state  ←── LEGACY PATH INJECTED HERE
home.selection.directory = D:\recover\...\reconstruction   [CONFIRMED, window dat]
handoff session ses_eea0… bound to legacy workspace key   [CONFIRMED, window dat]
live sessions (muse-spark) stored under legacy blob       [CONFIRMED, updated today]
  ↓
tool shell cwd = D:\recover\...\reconstruction            [OBSERVED: this session]
  ↓
agent reads legacy tree (code+docs+git @9d79ebb+dirty)
  ║
  ║  parallel reality (not read by agent):
  ║  D:\git\minicode @e284298 + staged P3.x files (19 commits newer)
```

## 17. State Dependency Graph

```text
ai.opencode.desktop window/workspace .dat  ──authoritative──→ active workspace + session binding
        ↑ writes on every session                      │ reads at launch/restore
user's continued sessions (legacy-bound keys) ──────────┘
.git/config origin (both clones) ──depends-on──→ repo-from-remote dir existence (inside legacy tree)
repo-from-remote HEAD (=e284298) ──tracks──→ canonical line (in sync)
legacy clone HEAD (9d79ebb) + uncommitted M1/P3.2 ──depends-on──→ manual migration (unmigrated work)
.minicode journals/sessions ──record──→ where runs happened (both trees; non-authoritative)
historical *.md headers ──mention──→ legacy path (reference only)
```

## 18. Legacy Data Inventory

| Item | Location | Type | Used by agent? | Authoritative? | Class |
|---|---|---|---|---|---|
| Git clone + objects (9d79ebb) | `reconstruction/.git` | GIT METADATA | yes (reads) | for legacy reads | ARCHIVE after migrate |
| Uncommitted M1 hunk (events.ts, journal.ts) | working tree | WORKSPACE diff | no (superseded: canonical committed+evolved) | no | DISCARD after hunk-verify |
| `src/runtime/`, `test/execution-id.test.ts` | untracked | files, byte-identical to canonical | no | no | DISCARD after verify |
| P3.2 `context-identity.*` + report | untracked | new work, canonical lacks it | yes (tests run here) | only copy | **MIGRATE** |
| `PHASE-P1-M0-BASELINE-REPORT.md` | untracked | doc | reference | historical | MIGRATE or ARCHIVE (owner) |
| `FINAL-RECONSTRUCTION-CLOSURE.md` copy | untracked | doc (canonical has committed one; equality UNVERIFIED — EOL/encoding) | reference | UNKNOWN | verify normalized, then DISCARD or MIGRATE |
| Journals/MEMORY/vector (today) | `.minicode` | execution traces | runtime | historical | RECREATE-if-needed / DISCARD (owner) |
| `sessions.db` (0 rows) | `.minicode` | empty store | no | no | DISCARD |
| `repo-from-remote` (remote repo, HEAD=e284298) | sibling dir | GIT METADATA + remote | yes (both clones' origin) | **yes for fetch/push** | KEEP (relocate only in plan) |
| `parseout/`, 28/09 forensic artifacts | sibling | recovery-operation residue | no | historical | ARCHIVE |
| OpenCode workspace blobs (legacy keys) | `%AppData%/ai.opencode.desktop` | MEMORY/session binding | **yes — active** | for UI | DETACH via plan (owner act) |
| `D:\git\minicode-old` (.freebuff+.minicode, 4 files) | `D:\git` | runtime-state remnant, non-repo | no | no | DISCARD (owner act; NOT this audit) |
| `D:\git\startupmini` | `D:\git` | unrelated website repo | no | no | KEEP (out of scope) |

## 19. Migration Dependency Inventory

| Dependency | Current source | Target source | Migration risk | Data-loss risk | Cutover complexity | Verification | Rollback |
|---|---|---|---|---|---|---|---|
| Agent session↔workspace binding | legacy-keyed blobs in app profile | canonical-keyed sessions | MED (live sessions) | LOW (history preserved if re-keyed, else session context split) | MED | open canonical dir; confirm new blob + session runs | re-open legacy dir (state kept until delete phase) |
| Launcher | clean (no change needed) | same | NONE | NONE | NONE | shortcut args empty (done) | n/a |
| IDE association | OpenCode window/home state | same, repointed | LOW | NONE | LOW | home.selection.directory == canonical | restore .dat (owner backup first) |
| Git remote path | legacy-tree local path (both clones) | canonical-safe location | HIGH (single dir both clones depend on) | LOW (objects duplicated; no alternates) | MED | fetch/push smoke post-move + tracking refs | keep dir until cutover verified |
| Uncommitted work (P3.2) | legacy tree only | canonical branch | LOW (3 files, additive, tested) | LOW | LOW | diff + focused tests green in canonical | files retained in legacy until delete phase |
| `.minicode` execution state | per-tree (both live) | per-tree (no move, no merge of journals) | LOW | LOW | LOW | sessions list per tree | n/a (additive) |
| Historical md references | 99 headers | leave (history) | NONE | NONE | NONE | grep count unchanged | n/a |
| Prompt/brief staleness (9d79ebb refs) | briefs, agent handoffs | refreshed brief | LOW | NONE | LOW | brief cites e284298+ | n/a |

## 20. Root Cause Ranking

- **ROOT CAUSE #1 — CONFIRMED**: OpenCode Desktop's persisted workspace/session state
  names the legacy path as current (home selection + handoff + live session blobs,
  all observed, two updated today). Sessions are keyed by workspace path, so every
  continued session re-anchors the agent in legacy. No code/config/shell/env/git
  involvement — all those vectors verified clean.
- **ROOT CAUSE #2 — HIGH CONFIDENCE**: git `origin` for both clones is a local path
  inside the legacy tree. The legacy *directory* (not just its memory) is an
  operational dependency; migration must relocate or re-point the remote, else
  canonical's fetch/push dies with the legacy folder.
- **ROOT CAUSE #3 — MEDIUM-HIGH CONFIDENCE**: work continued in legacy post-migration
  (uncommitted M1 07/10, P3.2 module/tests/report 08/10, live `.minicode` today) while
  canonical advanced separately — the agent keeps landing in legacy partly because
  that is where the newest *uncommitted* work and today's traces are. Stale briefs
  citing `9d79ebb`/legacy paths (including the brief that launched the P3.2 session
  in legacy cwd) reinforce this loop.
- Ruled out with evidence: launcher args, shell profiles, env vars, global agent
  config, VS Code/IDE files, git worktree/redirects, minicode internal state,
  unsafe fallbacks ("probably cache" rejected — the state is explicit UI persistence,
  not cache).

## 21. Authority Analysis

- Canonical repo authority: git in `D:\git\minicode` (healthy; HEAD e284298). Decides code truth. **No split.**
- Workspace authority: **OpenCode Desktop UI state** (`home.selection.directory` +
  session keys). Currently legacy. Decides where the agent works.
- Agent context authority: tool shell cwd inherited from the bound workspace (legacy).
  Decides which files the agent reads.
- Memory authority: per-workspace `.dat` blobs (+ minicode MEMORY.md per tree, tree-local).
  Decides remembered workspace — legacy for live sessions.
- Recovery authority: session-restore (reopens legacy-bound sessions); git remote path
  (depends on legacy dir). No minicode-level workspace fallback exists.
- Git authority: does git reference legacy? Topologically no; as `origin` URL yes
  (both clones).
- IDE authority: OpenCode Desktop associates live sessions with legacy; canonical
  known (06/10 blob) but not active.
- **Verdict: AUTHORITY SPLIT** — code truth lives in canonical; work/memory/fetch
  authority still lives in (or depends on) legacy.

## 22. Migration Completeness Assessment

**REPO MIGRATED / TOOLING NOT MIGRATED** (with active divergence). Code HEAD migrated
(canonical +19, in sync with remote, M1 committed, EOL fix + closure landed). Not
migrated: agent workspace binding (live sessions in legacy), git remote location
(inside legacy tree), uncommitted P3.2 work (legacy-only), 5 staged-but-uncommitted
P3.x files in canonical, stale tracking ref + stale briefs. Calling it "fully
migrated" is **false** on current evidence.

## 23. Data That Must NOT Be Migrated

Historical `Workspace:` headers in committed reports (history, not pointers);
per-record `cwd` in journals (execution history — moving it falsifies history);
`D:\git\minicode-old` runtime remnants; `parseout/` + 28/09 forensic artifacts;
empty legacy `sessions.db`; machine-specific OpenCode caches (`Cache/`, `GPUCache/`,
`blob_storage/`); any secret-shaped values (none observed; credential helper config
left untouched); the redundant byte-identical M1 copies (already canonical).

## 24. Risks

Deleting/relocating the legacy tree before re-pointing `origin` breaks fetch/push for
canonical too (both clones share the path). Re-keying live sessions can split session
context (owner must decide per §26). The 5 staged-uncommitted P3.x files in canonical
are one `git reset` away from disappearing from the index (uncommitted = fragile).
Legacy HEAD (9d79ebb) is 6 days behind with an unrelated newer line in canonical —
any merge/rebase strategy must treat legacy work as a topic, never fast-forward over
canonical. Network state of GitHub (`startupmini/minicode`) was not probed (read-only
boundary observed: no fetch/pull executed) — remote truth beyond `repo-from-remote`
is UNKNOWN.

## 25. Recommended Migration Phases

Phase candidates only (no implementation detail; architect owns the plan):

- Phase A — quiesce legacy sessions (no new work lands in legacy; inventory frozen)
- Phase B — land uncommitted work (P3.2 topic into canonical; verify; keep legacy copies)
- Phase C — detach agent memory (re-key/continue sessions under canonical workspace key)
- Phase D — repoint IDE association (home selection + handoff to canonical)
- Phase E — relocate git remote dependency out of the legacy tree (both clones + tracking refs)
- Phase F — cutover verification (agent session runs in canonical; fetch/push smoke; brief refresh)
- Phase G — archive legacy (read-only snapshot) then delete (owner-executed, post-verification)

## 26. What Requires Owner Decision

Whether live legacy sessions are re-keyed vs closed-and-reopened; fate of the 5
staged-uncommitted P3.x files (commit vs discard); fate of P3.2 work-product location;
new home for the shared local remote (or cutover to GitHub URL); archive format/retention
for the legacy tree; refreshed brief pinning `e284298`+canonical path; GitHub-side
verification (fetch/compare, network action — not done in this audit).

## 27. Audit Verdict

Migration claimed complete is refuted by persisted app state, an in-tree git remote,
and live divergent work. The mechanism is ordinary and fully evidenced — no exotic
cause, no corruption, no cache mystery.

```text
CANONICAL WORKSPACE:
D:\git\minicode

LEGACY WORKSPACE:
D:\recover\minicode-20260928\reconstruction

LEGACY IS:
Independent git clone (own .git, HEAD 9d79ebb + uncommitted work, stale tracking ref)

PRIMARY ROOT CAUSE:
OpenCode Desktop persisted workspace/session state binds live sessions to the legacy
path (home.selection.directory + handoff dir + session-keyed blobs, two updated today)

LEGACY PATH ENTERS SYSTEM AT:
Workspace/session discovery from %AppData%\Roaming\ai.opencode.desktop UI state
(opencode.window.*.dat, opencode.workspace.D--recover-m.*.dat) — before any repo tooling

AUTHORITY:
SPLIT — code truth in canonical; workspace/memory/fetch authority in (or dependent on) legacy

MIGRATION STATUS:
REPO MIGRATED / TOOLING NOT MIGRATED (active divergence, not fully migrated)

ACTIVE LEGACY DEPENDENCIES:
live agent sessions; home/handoff selection; both clones' git origin path; uncommitted P3.2 work

SAFE-TO-MIGRATE:
P3.2 module+tests+report (additive, tested); session re-keying; remote relocation; brief refresh

DO-NOT-MIGRATE:
historical md headers; journal cwd history; minicode-old remnants; parseout/28-09 artifacts;
empty sessions.db; app caches; byte-identical M1 copies (already canonical)

OWNER DECISIONS:
session re-key vs close; staged P3.x files fate; P3.2 landing; remote new home;
legacy archive retention; brief refresh; GitHub-side check

CONFIDENCE:
HIGH (RC#1 confirmed by live state; RC#2/RC#3 evidenced; negatives verified per vector)

AUDIT STATUS:
COMPLETE
```
