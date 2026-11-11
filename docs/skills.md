# Skills & Hooks

## Skills

Skill = file markdown dengan frontmatter `name` + `description`, diletakkan di `.minicode/skills/*.md` (recursive, `**/*.md` juga didukung):

```markdown
---
name: review
description: Review code changes
---
Review this diff: {{args}}
```

- Placeholder di body: `{{args}}` atau `$ARGUMENTS` — menerima argumen setelah nama skill.
- Nama auto-slug: `My Skill` → `my-skill`.
- Panggil dari TUI atau prompt one-shot: `/review src/a.ts` atau `minicode "/review src/a.ts"`.
- Skill tampil di dropdown `/` (grouped bersama slash command) dan `minicode skills list` melihat yang terpasang.
- **`disable-model-invocation: true`** di frontmatter = skill HANYA via `/nama` eksplisit, tak masuk katalog auto-pick system prompt. Untuk workflow yang tak boleh dipicu model sendiri (deploy/rilis).
- **Aset sibling** (opsional, gaya Zed): folder `.minicode/skills/<nama>/` berisi `scripts/` dan `references/` — didaftar sebagai petunjuk baca di katalog (`scripts: check.sh; refs: guide.md`), dibaca model via `read_file` bila perlu, TIDAK dieksekusi otomatis.

Perilaku penting:

- Skill **bukan tool** — ia memanjangkan prompt pertama, jadi tetap tunduk pada permission mode yang sama.
- Dropdown `/` menawarkan perintah builtin, driver command (`/compact`/`/thinking`/`/expand`/…), dan skill terpasang. `Tab` BUKAN autocomplete — ia memutar WorkMode (`Shift+Tab` memutar PermissionMode).

## AGENTS.md: instruksi proyek

`/init` membuat `AGENTS.md` untuk proyek yang sedang Anda kerjakan. File ini (bersama `MEMORY.md` hierarki) ikut ke system prompt setiap run — tempat yang tepat untuk konvensi build, aturan lint, dan "jangan sentuh X". Urutan & detail memory di [Memory](memory-sessions.md).

## Hooks

Hooks mati secara default; nyalakan dengan `MINICODE_HOOKS=1`.

| Hal | Detail |
|---|---|
| Lokasi | Global `~/.minicode/hooks/*.js` + lokal `.minicode/hooks/*.js` |
| Titik jalan | `pre-run` dan `post-run` |
| Konteks | Env `MINICODE_HOOK_CTX` (JSON run) |
| Sanitasi | Env hook disanitasi tanpa secret; hook dilewati bila sesi dibatalkan |

Hooks global + lokal di-merge (bukan lewat allowlist). Karena hook adalah kode arbitrer di luar permission system, ia hanya jalan bila `MINICODE_HOOKS=1` dan WorkMode `EXECUTE` (tidak di `DISCUSS`/`PLAN`); setiap hook dikenai timeout 5 dtk dan env-nya disanitasi. Repo clone-an bisa menyuntik `.minicode/hooks/*.js` — perlakukan seperti config lokal yang tak tepercaya (lihat [Keamanan](security.md)).

## Lanjut

- [TUI](repl.md) - dropdown + slash command.
- [Config](config.md) — lokasi file & skema config.
- [Tools](tools.md) — capability yang tersedia untuk skill.
