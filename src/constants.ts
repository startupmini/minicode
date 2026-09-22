/** Centralized magic numbers — full English naming. Single source for limits. */
export const LIMITS = {
  /** File size limits */
  READ_FILE_MAX_BYTES: 2_000_000,
  WRITE_FILE_MAX_CHARS: 5_000_000,
  /** read_file paging — file besar dibaca per rentang baris, bukan sekaligus */
  READ_FILE_DEFAULT_LINE_LIMIT: 2_000,
  READ_FILE_MAX_LINE_LIMIT: 5_000,
  READ_FILE_MAX_LINE_CHARS: 2_000,
  /** Tool output truncation */
  BASH_OUTPUT_MAX_CHARS: 20_000,
  BASH_DEFAULT_TIMEOUT_MS: 30_000,
  /** bash background: proses hidup melewati batas turn, dipanggil via bash_output */
  BASH_BACKGROUND_MAX_JOBS: 8,
  BASH_BACKGROUND_MAX_LIFETIME_MS: 3_600_000,
  DOCKER_OUTPUT_MAX_CHARS: 100_000,
  MCP_OUTPUT_MAX_CHARS: 100_000,
  MCP_REQUEST_TIMEOUT_MS: 30_000,
  TASK_SUB_AGENT_MAX_TOKENS: 2_000,
  /** Context & memory */
  SYSTEM_PROMPT_MAX_CHARS: 8_000,
  MEMORY_FILE_MAX_CHARS: 4_000,
  MEMORY_FILE_MAX_BYTES: 200_000,
  MEMORY_TRUNCATE_KEEP_BYTES: 150_000,
  AGENTS_MD_MAX_CHARS: 3_000,
  COMPACTION_SUMMARY_MAX_CHARS: 1_500,
  COMPACTION_LLM_TIMEOUT_MS: 10_000,
  /** F3.1 anti-thrash: kompaksi LLM yang mengurangi <10% dihitung tak
   * berprogres (satu output tool raksasa mendominasi jendela); 2× beruntun
   * = thrash → jalur LLM dimatikan sesi-ini (mekanikal saja). */
  COMPACTION_THRASH_MIN_PROGRESS: 0.1,
  COMPACTION_THRASH_MAX_STREAK: 2,
  EMBEDDING_TIMEOUT_MS: 3_500,
  /** Budget TOTAL semua attempt embedding (3 header × 2 URL sekuensial):
   * tanpa ini endpoint lambat-menjawab menahan RAG setup ~21 dtk (6×3,5 dtk
   * + DNS per attempt) dengan spinner "Menyiapkan sesi…" yang diam = macet.
   * Lewat budget = fallback keyword, bukan hang. */
  EMBEDDING_TOTAL_TIMEOUT_MS: 10_000,
  VECTOR_SEARCH_LIMIT: 500,
  VECTOR_RECENT_LIMIT: 300,
  VECTOR_KEYWORD_LIMIT: 200,
  MEMORY_MIN_SCORE_HYBRID: 0.2,
  MEMORY_MIN_SCORE_KEYWORD: 0.25,
  /** P13 P1 — TTL hierarkis per kategori (hari): fakta awet, ringkasan
   * sedang, snippet cepat basi. Menggantikan MEMORY_TTL_DAYS flat 90. */
  MEMORY_TTL_FACT_DAYS: 180,
  MEMORY_TTL_SUMMARY_DAYS: 90,
  MEMORY_TTL_SNIPPET_DAYS: 14,
  MEMORY_MAX_ROWS: 5000,
  /** P2 MMR: bobot relevansi vs diversitas + ambang dedup near-duplikat */
  MEMORY_MMR_LAMBDA: 0.7,
  MEMORY_MMR_CANDIDATES: 50,
  MEMORY_DEDUP_COSINE: 0.92,
  /** P2 chunking: entri panjang dipecah per baris ini dengan overlap */
  MEMORY_CHUNK_CHARS: 2000,
  MEMORY_CHUNK_OVERLAP: 200,
  WORKSPACE_SNAPSHOT_LIMIT: 200,
  CHECKPOINT_MAX_COUNT: 20,
  /** Checkpoint shadow-git: operasi git punya deadline sendiri agar turn tak
   * tergantung repo raksasa; batch path menghindari batas command-line Windows. */
  SHADOW_GIT_TIMEOUT_MS: 20_000,
  SHADOW_GIT_PATH_BATCH: 200,
  /** Tool git (status/diff/log/commit). Longgar karena `git_commit` menjalankan
   * beberapa operasi berurutan dan mesin sibuk membuat spawn git lambat. */
  GIT_TIMEOUT_MS: 20_000,
  /** F-15: cap output git saat streaming (git_diff/log di repo raksasa). */
  GIT_OUTPUT_MAX_CHARS: 500_000,
  /** Executor & sub-agents — tuned for 4-core laptop (6/1) vs 8/2 server */
  DEFAULT_MAX_STEPS: 50,
  EXECUTOR_CONCURRENCY: 6,
  EXECUTOR_WRITE_CONCURRENCY: 1,
  SUB_AGENT_POOL_SIZE: 3,
  SUB_AGENT_BUDGET_EXPLORE: 5,
  SUB_AGENT_BUDGET_PLAN: 15,
  SUB_AGENT_TIMEOUT_MS: 120_000,
  /** Network / providers */
  RETRY_AFTER_MAX_MS: 30_000,
  /** F-11: timeout per request provider (server hung = turn hung tanpa ini).
   * Longgar (5 mnt) karena reasoning stream sah bisa bermenit-menit; timeout
   * turn (default 10–15 mnt) tetap backstop terluar. */
  PROVIDER_REQUEST_TIMEOUT_MS: 300_000,
  /** F-16: cap akumulasi teks per stream (anti-OOM); hanya memotong kasus
   * patologis (~250rb token teks dalam satu turn). */
  PROVIDER_TEXT_MAX_CHARS: 1_000_000,
  /** Investigasi Phase 5: cap reasoning stream (terbukti TANPA cap = akumulasi
   * tak terbatas — satu-satunya jalur loop `reasoning +=` tanpa batas). */
  PROVIDER_REASON_MAX_CHARS: 2_000_000,
  DOCKER_TIMEOUT_MS: 30_000,
  DETECT_MODELS_TIMEOUT_MS: 4_000,
  DETECT_GLOBAL_TIMEOUT_MS: 6_000,
  DETECT_ATTEMPT_TIMEOUT_MS: 2_500,
  MCP_HANDSHAKE_TIMEOUT_MS: 3_000,
  /** OAuth device flow: request pendek, tapi poll bisa berlangsung menit. */
  OAUTH_REQUEST_TIMEOUT_MS: 15_000,
  /** Pricing dari models.dev — cache agar tidak menembak jaringan tiap run. */
  PRICING_FETCH_TIMEOUT_MS: 5_000,
  PRICING_CACHE_TTL_MS: 86_400_000,
  LSP_DIAGNOSTICS_TIMEOUT_MS: 5_000,
  LSP_INIT_TIMEOUT_MS: 15_000,
  VERIFY_DEFAULT_TIMEOUT_MS: 30_000,
  WEB_FETCH_BODY_HARD_CAP_CHARS: 2_000_000,
  WEB_FETCH_MAX_REDIRECTS: 5,
  /** Glob/grep */
  SEARCH_DEFAULT_LIMIT: 100,
  SEARCH_MAX_LIMIT: 500,
  /** grep: ripgrep dipakai bila ada di PATH; fallback walker JS */
  GREP_RIPGREP_TIMEOUT_MS: 15_000,
  GREP_MATCH_MAX_CHARS: 300,
  GREP_FILE_MAX_BYTES: 1_000_000,
  /** todo list per sesi */
  TODO_MAX_ITEMS: 50,
  TODO_CONTENT_MAX_CHARS: 200,
  /** SQLite */
  SQLITE_BUSY_TIMEOUT_MS: 3_000,
  SQLITE_WAL_SIZE_LIMIT_BYTES: 33_554_432,
  SQLITE_WAL_AUTOCHECKPOINT_PAGES: 1_000,
  /** Telemetry */
  TRACE_MAX_LINES: 1_000,
  /** Repo-map */
  REPOMAP_MAX_FILES: 60,
  REPOMAP_MAX_FILE_BYTES: 100_000,
  REPOMAP_MAX_CHARS: 2_500,
  REPOMAP_MAX_SYMBOLS_PER_FILE: 40,
} as const
