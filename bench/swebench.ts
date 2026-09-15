#!/usr/bin/env bun

// SWE-bench Lite runner — 20 instance terstratifikasi, clone+checkout, verify pytest.
// Dipakai untuk P10 P1.2: angka resolve rate TERCETAK dari run nyata sebelum boleh dikutip.
// Usage: bun bench/swebench.ts [--fake] [--limit 20] [--dataset bench/swebench_lite.jsonl] [--docker]
//   Real run tanpa menyentuh config: --api-key-env NAMA_ENV --base-url URL --model ID
//   (kunci tetap di environment, tak pernah ditulis ke disk) [--max-steps 25]
//   --docker: skoring pytest di container era (bench/docker/manifest.json);
//   butuh daemon, gagal bersih bila tak ada. Repo di-pip-install -e . dulu
//   di container (tanpa ini import gagal dan skoring kolaps).
//   --verify-only: lewati agen (tanpa API key) — validasi harness+lingkungan
//   saja: clone, test_patch, pip install, pytest FAIL_TO_PASS. Untuk
//   confidence-low dan diagnosis; bukan skor agen.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ModelProvider } from "#minicore"
import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { loadConfig } from "../src/config.ts"
import { createUsageCollector } from "../src/policy/usage.ts"
import { buildProviderList } from "../src/providers/build.ts"
import { createRouterProvider } from "../src/providers/router.ts"
import { dockerAvailable } from "../src/sandbox/docker.ts"
import { allTools } from "../src/tools/index.ts"

interface SweInstance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  test_patch?: string
  FAIL_TO_PASS: string[]
  PASS_TO_PASS: string[]
}

function loadDataset(path: string): SweInstance[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  return lines.map((l) => JSON.parse(l) as SweInstance)
}

const DATASET =
  process.argv.find((a) => a.startsWith("--dataset="))?.split("=")[1] ??
  "bench/swebench_lite_20.jsonl"
const fake = process.argv.includes("--fake")
const limitArg = process.argv.indexOf("--limit")
const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : 20
const maxStepsArg = process.argv.indexOf("--max-steps")
const maxSteps = maxStepsArg !== -1 ? Number(process.argv[maxStepsArg + 1]) : undefined
function flagVal(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

// Satu fungsi verify untuk FAIL_TO_PASS dan PASS_TO_PASS — daftar kosong
// berarti tidak ada yang diuji (true), bukan lolos.
export interface SuiteVerdict {
  /** false bila pip install gagal (docker) — tanpa install tak ada verdict valid. */
  installOk: boolean
  /** Exit code pytest: 0 lolos, 1 gagal-asersi, lain/null = masalah harness
   * (2 collection, 3 internal, 4 usage, 5 tak ada test terkumpul, null = timeout). */
  code: number | null
}

function runPytest(dir: string, tests: string[], era?: DockerEra): SuiteVerdict {
  if (tests.length === 0) return { installOk: true, code: 0 }
  if (era) return runPytestDocker(dir, tests, era.image, era.runner, era.deps)
  const verify = spawnSync("python", ["-m", "pytest", ...tests, "-q"], {
    cwd: dir,
    timeout: 180000,
    encoding: "utf8",
  })
  return { installOk: true, code: verify.status }
}

// Docker per-era (bench/docker/): skoring jalan di container Python era
// instance, bukan Python host. Pure builder di bawah agar bisa diuji tanpa
// daemon; eksekusi gagal bersih bila docker tak ada.
export interface DockerEra {
  image: string
  runner: "pytest" | "django"
  /** Paket pip tambahan era (mis. sympy→mpmath==1.0.0): di-install bersama
   * `pip install -e .` di container yang SAMA dengan pytest. WAJIB sama
   * container — tiap `docker run` filesystem-nya ephemeral, install di run
   * terpisah hilang sebelum pytest jalan (bug nyata saat validasi sympy). */
  deps?: string[]
}

export function dockerMountArg(dir: string): string {
  // Docker Desktop di Windows butuh bentuk //c/x, bukan C:\x.
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir)
    if (m) return `//${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`
  }
  return dir
}

export function buildDockerTestCommand(era: DockerEra, dir: string, tests: string[]): string[] {
  // Install + test dalam SATU container (sh -c chain): filesystem container
  // ephemeral per `docker run`, jadi install terpisah = hilang sia-sia.
  // Quote hanya data variabel (dir sudah aman sebagai argv spawnSync;
  // image dari manifest tepercaya): ID test/dep aneh tak boleh memecah shell.
  // Marker SWE_INSTALL/SWE_TEST memisahkan kegagalan install (harness) dari
  // verdict pytest — tanpa ini collection-error disangka FAIL model.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const deps = (era.deps ?? []).map(q).join(" ")
  const install = `pip install --no-cache-dir -e .${deps ? ` ${deps}` : ""}`
  const test =
    era.runner === "django"
      ? `python tests/runtests.py ${tests.map(q).join(" ")} -v 0`
      : `python -m pytest ${tests.map(q).join(" ")} -q`
  return [
    "docker",
    "run",
    "--rm",
    "-v",
    `${dockerMountArg(dir)}:/repo`,
    "-w",
    "/repo",
    era.image,
    "sh",
    "-c",
    `${install} 2>&1; echo SWE_INSTALL=$?; ${test} 2>&1; echo SWE_TEST=$?`,
  ]
}

function parseSuiteMarkers(out: string): { installOk: boolean; code: number | null } {
  const inst = /SWE_INSTALL=(-?\d+)/.exec(out)?.[1]
  const tst = /SWE_TEST=(-?\d+)/.exec(out)?.[1]
  return {
    installOk: inst != null && Number(inst) === 0,
    code: tst != null ? Number(tst) : null,
  }
}

/**
 * Bedakan verdict model dari masalah harness (murni, teruji): hanya exit 0
 * (lolos) dan 1 (gagal asersi) yang merupakan verdict. Exit 2 (interupsi/
 * collection), 3 (internal), 4 (usage), 5 (tak ada test terkumpul), null
 * (timeout), atau install gagal = ERROR harness — melempar agar instance
 * dicatat error, bukan "FAIL model". Tanpa ini collection-error (kasus nyata:
 * shim py.test sympy vs pytest modern) disangka model gagal.
 */
export function interpretCodes(
  fail: SuiteVerdict,
  pass: SuiteVerdict,
  instanceId: string,
): { passed: boolean; failCode: number | null; passCode: number | null } {
  if (!fail.installOk || !pass.installOk)
    throw new Error(`pip install failed ${instanceId} (skoring tanpa install = fiksi)`)
  for (const [name, v] of [
    ["FAIL_TO_PASS", fail],
    ["PASS_TO_PASS", pass],
  ] as const) {
    if (v.code == null) throw new Error(`${name} tak selesai ${instanceId} (timeout/sinyal)`)
    if (v.code !== 0 && v.code !== 1)
      throw new Error(`${name} harness ${instanceId} (exit ${v.code}: bukan verdict model)`)
  }
  return { passed: fail.code === 0 && pass.code === 0, failCode: fail.code, passCode: pass.code }
}

function runPytestDocker(
  dir: string,
  tests: string[],
  image: string,
  runner: DockerEra["runner"] = "pytest",
  deps: string[] = [],
): SuiteVerdict {
  const argv = buildDockerTestCommand({ image, runner, deps }, dir, tests)
  const verify = spawnSync(argv[0]!, argv.slice(1), { timeout: 300000, encoding: "utf8" })
  // Timeout kill (status null) masih bisa menyisakan marker parsial di output.
  return parseSuiteMarkers(verify.stdout ?? "")
}

interface EraManifest {
  images: Record<string, string>
  instances: {
    id: string
    python: string
    pytest: string
    runner: string
    confidence: string
    /** Paket pip tambahan era (mis. sympy→mpmath==1.0.0): di-install
     * bersama `pip install -e .` di container yang SAMA dengan pytest. */
    deps?: string[]
  }[]
}

let eraCache: EraManifest | null | undefined
export function loadEraManifest(): EraManifest | null {
  if (eraCache !== undefined) return eraCache
  try {
    const p = join(fileURLToPath(new URL(".", import.meta.url)), "docker", "manifest.json")
    eraCache = JSON.parse(readFileSync(p, "utf8")) as EraManifest
  } catch {
    eraCache = null
  }
  return eraCache
}

export function eraForInstance(instanceId: string): DockerEra | null {
  const m = loadEraManifest()
  const e = m?.instances.find((i) => i.id === instanceId)
  if (!e) return null
  const image = m!.images[e.python]
  if (!image) return null
  return { image, runner: e.runner === "django" ? "django" : "pytest", deps: e.deps ?? [] }
}

async function runOne(
  inst: SweInstance,
  provider: ModelProvider | null,
  useDocker: boolean,
  verifyOnly = false,
): Promise<{
  id: string
  passed: boolean
  durationMs: number
  failCode: number | null
  passCode: number | null
}> {
  const dir = mkdtempSync(join(tmpdir(), "swe-"))
  const t0 = Date.now()
  let passed = false
  let failCode: number | null = null
  let passCode: number | null = null
  try {
    if (useDocker && !dockerAvailable()) throw new Error("docker unavailable (daemon tak jalan)")
    const era = useDocker ? eraForInstance(inst.instance_id) : null
    if (useDocker && !era) throw new Error(`no era manifest for ${inst.instance_id}`)
    // clone + checkout base_commit
    const clone = spawnSync("git", ["clone", `https://github.com/${inst.repo}.git`, dir], {
      stdio: "ignore",
      timeout: 120000,
    })
    if (clone.status !== 0) throw new Error(`clone failed ${inst.repo}`)
    spawnSync("git", ["-C", dir, "checkout", inst.base_commit], { stdio: "ignore", timeout: 30000 })

    // test_patch WAJIB di-apply dulu: tanpa test baru, FAIL_TO_PASS tidak ada
    // dan patch benar pun tak terukur. Versi lama melewatkan ini sehingga
    // skornya fiksi (selalu lolos bila FAIL_TO_PASS kosong).
    if (inst.test_patch) {
      const { writeFileSync } = await import("node:fs")
      const patchFile = join(dir, "swe_test.patch")
      writeFileSync(patchFile, inst.test_patch)
      const applied = spawnSync("git", ["-C", dir, "apply", patchFile], {
        stdio: "ignore",
        timeout: 30000,
      })
      if (applied.status !== 0) throw new Error(`test_patch failed ${inst.instance_id}`)
    }

    // --verify-only: validasi harness+lingkungan saja (clone/patch/install/
    // pytest), tanpa menjalankan agen — untuk confidence-low dan diagnosis.
    // Provider tak dibutuhkan sama sekali di jalur ini.
    if (!verifyOnly) {
      if (!provider) throw new Error("no provider (use --fake atau kredensial)")
      const session = await createMinicodeSession({
        provider,
        tools: allTools,
        cwd: dir,
        permissionMode: "auto",
        ...(maxSteps ? { maxSteps } : {}),
      })
      const usage = createUsageCollector(session.events)
      await session.run(inst.problem_statement, {})
      void usage.get()
    }

    // verify: SEMUA FAIL_TO_PASS + sampel PASS_TO_PASS harus hijau via pytest.
    // --docker: skoring di container era (image dari manifest), bukan host.
    // interpretCodes: exit selain 0/1 = ERROR harness (bukan FAIL model).
    const verdict = interpretCodes(
      runPytest(dir, inst.FAIL_TO_PASS, era ?? undefined),
      runPytest(dir, inst.PASS_TO_PASS.slice(0, 3), era ?? undefined),
      inst.instance_id,
    )
    passed = verdict.passed
    failCode = verdict.failCode
    passCode = verdict.passCode
  } catch (e) {
    // Diagnosa ke stderr (ringkas, tanpa secret): tanpa ini semua FAIL terlihat
    // sama — bedakan clone/test_patch/LLM/pytest sejak awal.
    process.stderr.write(
      `[swebench] ${inst.instance_id} error: ${String((e as Error)?.message ?? e).slice(0, 300)}\n`,
    )
    passed = false
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return { id: inst.instance_id, passed, durationMs: Date.now() - t0, failCode, passCode }
}

async function main() {
  let provider: ModelProvider | null = null
  const verifyOnly = process.argv.includes("--verify-only")
  if (fake) {
    provider = {
      id: "fake",
      models: ["fake"],
      async *stream() {
        yield { type: "text", text: "done" }
        yield { type: "finish", reason: "stop" }
      },
    }
  } else if (!verifyOnly) {
    // Jalur env: provider ad-hoc tanpa menyentuh ~/.minicode/config.json.
    // Kunci dibaca dari environment (tak pernah ditulis ke disk/jejak config).
    // --verify-only tak butuh provider sama sekali (tanpa sesi agen) —
    // jangan gagal hanya karena mesin validasi tak punya kunci API.
    const keyEnv = flagVal("--api-key-env")
    const baseUrl = flagVal("--base-url")
    const model = flagVal("--model")
    if (keyEnv && baseUrl && model) {
      const apiKey = process.env[keyEnv]
      if (!apiKey) {
        console.error(`env ${keyEnv} kosong — export dulu sebelum real run`)
        process.exit(1)
      }
      const solo = createOpenAICompatProvider({
        baseUrl,
        apiKey,
        models: [model],
        defaultModel: model,
      })
      provider = createRouterProvider({ providers: [solo] })
    } else {
      const cfg = await loadConfig()
      const providers = buildProviderList(cfg)
      if (providers.length === 0) {
        console.error("no provider — use --fake or configure one")
        process.exit(1)
      }
      provider = createRouterProvider({ providers })
    }
  }

  let instances = loadDataset(DATASET)
  if (instances.length === 0) {
    // fallback: 20 instance dummy agar angka tetap tercetak (stub jujur)
    console.error(`[swebench] dataset ${DATASET} not found — using 20 dummy instances (stub)`)
    instances = Array.from({ length: 20 }, (_, i) => ({
      instance_id: `dummy-${i}`,
      repo: "dummy/repo",
      base_commit: "main",
      problem_statement: `dummy task ${i}: fix bug`,
      FAIL_TO_PASS: [],
      PASS_TO_PASS: [],
    }))
  }
  instances = instances.slice(0, limit)

  let resolved = 0
  const useDocker = process.argv.includes("--docker")
  if (useDocker && !fake && !dockerAvailable()) {
    console.error(
      "[swebench] --docker diminta tapi docker unavailable — semua instance akan FAIL jujur (bukan skor fiksi)",
    )
  }
  for (const inst of instances) {
    const r = fake
      ? { id: inst.instance_id, passed: false, durationMs: 10, failCode: null, passCode: null }
      : await runOne(inst, provider, useDocker, verifyOnly)
    if (r.passed) resolved++
    process.stdout.write(
      `${r.passed ? "PASS" : "FAIL"} ${r.id} ${r.durationMs}ms (fail=${r.failCode ?? "-"} pass=${r.passCode ?? "-"})\n`,
    )
  }
  const rate = instances.length ? resolved / instances.length : 0
  console.log(
    `\n[swebench] resolve rate: ${resolved}/${instances.length} (${rate.toFixed(3)}) — ${fake ? "fake" : "real"} run`,
  )
  // tulis results.json agar delta terlihat
  try {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      "bench/swebench_results.json",
      JSON.stringify(
        {
          resolved,
          total: instances.length,
          rate,
          fake,
          model: fake ? "fake" : (flagVal("--model") ?? "config"),
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } catch {}
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
