# Quickstart 5 menit

Tujuan: dari nol sampai prompt pertama yang ter-verify, tanpa membaca seluruh manual.

## 1. Jalan pertama (1 menit)

```bash
minicode
```

Bila belum ada provider, wizard setup muncul. Isi berurutan: pilih gateway → tempel API key (ter-masking) → auto-detect models. Wizard memakai picker (panah + filter), bukan `readline` nomor — mengetik di luar rentang tidak lagi diam-diam memilih `[0]`.

Alternatif tanpa API key:

```bash
minicode auth login          # device-code: kode singkat + URL, setujui di browser
minicode auth status         # lihat kredensial + kapan kedaluwarsa
```

## 2. Prompt pertama (2 menit)

```bash
minicode "buat http server hello world di server.ts" --verbose
```

Yang terjadi: model menerima system prompt berisi `# Environment` (cwd + platform) + repo-map ringkas, lalu loop ReAct `Thought → Action → Observation` sampai jawaban final atau batas (`--max-steps` default 50, `--timeout` default 15 menit).

Coba mode interaktif:

```bash
minicode --interactive
# minicode › jelaskan isi src/tools/index.ts
# /model   → picker provider::model, Enter = pilih + atur effort
# /status  → token + biaya kumulatif sesi
# /exit    → keluar (Ctrl+C ganda juga bisa)
```

## 3. Verify otomatis (2 menit)

```bash
minicode --verify "fix bugs lalu typecheck"
```

Sebelum agen jalan, baseline diuji dulu. Bila baseline sudah merah, catatan Health-Check ditempel ke prompt awal agar agen memperbaiki dulu. Setelah run, verify dijalankan; bila gagal, agen self-heal maks 3 siklus. Output error dibungkus fence agar tidak jadi prompt injection. Custom command via `MINICODE_VERIFY_CMD` atau `verifyCommand` di config.

## Contoh pola harian

```bash
minicode --ask "deploy script"          # human-in-loop confirmation card
minicode --sandbox docker "task"        # bash di container ephemeral
minicode --budget 0.50 "task besar"     # warn 80%; pagu lewat → prompt baru ditolak + turn berjalan digugurkan
minicode exec "prompt" --json           # headless CI: JSONL stream + summary
minicode "/review src/a.ts"             # skill slash-command
```

## Berikutnya

- [CLI](cli.md) untuk semua mode + flags.
- [REPL](repl.md) untuk slash command dan keyboard.
- [Config & Provider](config-providers.md) untuk pindah gateway dan model.
