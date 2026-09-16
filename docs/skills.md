\n
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
- Panggil dari REPL atau prompt one-shot: `/review src/a.ts` atau `minicode "/review src/a.ts"`.
- Skill tampil di dropdown `/` (grouped bersama slash command) dan `minicode skills list` melihat yang terpasang.

Perilaku penting:

- Skill **bukan tool** — ia memanjangkan prompt pertama, jadi tetap tunduk pada permission mode yang sama.
- Tab di dropdown hanya menawarkan perintah builtin + `/compact`; skill tetap bisa diketik manual dan ter-lookup grouped saat keduanya match.

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

Hooks global + lokal di-merge dari allowlist secara atomik (chmod 600). Karena hook adalah kode arbitrer, hanya allowlist yang terdaftar yang jalan — repo clone-an tidak bisa menyuntik hook sendiri tanpa Anda percayai (sama dengan aturan config lokal; lihat [Keamanan](security.md)).

## Lanjut

- [REPL](repl.md) — dropdown + slash command.
- [Config](config.md) — lokasi file & skema config.
- [Tools](tools.md) — referensi 37 tool yang bisa dipanggil skill.
