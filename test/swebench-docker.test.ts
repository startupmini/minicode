import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  buildDockerTestCommand,
  dockerMountArg,
  eraForInstance,
  interpretCodes,
  loadEraManifest,
} from "../bench/swebench.ts"

// Docker per-era SWE-Lite: manifest + command builder teruji tanpa daemon.
// Eksekusi container nyata butuh daemon (tak ada di CI Windows) — lihat
// bench/docker/README.md untuk batas kejujuran.
describe("swebench docker: manifest", () => {
  test("mencakup semua 20 instance dataset", () => {
    const dataset = readFileSync("bench/swebench_lite_20.jsonl", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { instance_id: string }).instance_id)
    expect(dataset.length).toBe(20)
    const m = loadEraManifest()
    expect(m).not.toBeNull()
    for (const id of dataset) expect(eraForInstance(id)).not.toBeNull()
  })

  test("python valid + pytest pin konsisten", () => {
    const m = loadEraManifest()!
    for (const e of m.instances) {
      expect(Object.keys(m.images)).toContain(e.python)
      if (e.python === "3.6") {
        // pytest 7.x butuh Python >=3.7 — pin 3.6 WAJIB major 6 (pip menolak
        // 7.x di 3.6; dulu "7.0" yang tak pernah bisa terinstall).
        expect(e.pytest.startsWith("6.")).toBe(true)
      } else {
        expect(e.pytest).toBe("7.4")
      }
      expect(["pytest", "django"]).toContain(e.runner)
      expect(["high", "medium", "low"]).toContain(e.confidence)
    }
  })

  test("instance tak dikenal -> null (fail-closed, bukan tebak image)", () => {
    expect(eraForInstance("bukan-instance")).toBeNull()
  })
})

describe("swebench docker: command builder", () => {
  test("pytest runner: mount + workdir + image + install&&test satu container", () => {
    const argv = buildDockerTestCommand(
      { image: "minicode-swe:py39", runner: "pytest" },
      "/tmp/x",
      ["a.py::T::t"],
    )
    expect(argv.slice(0, 7)).toEqual(["docker", "run", "--rm", "-v", "/tmp/x:/repo", "-w", "/repo"])
    expect(argv).toContain("minicode-swe:py39")
    const shell = argv[argv.length - 1]!
    expect(shell).toContain("pip install --no-cache-dir -e .")
    expect(shell).toContain("python -m pytest 'a.py::T::t' -q")
  })

  test("django runner memakai tests/runtests.py", () => {
    const argv = buildDockerTestCommand(
      { image: "minicode-swe:py37", runner: "django" },
      "/tmp/x",
      ["queries.test"],
    )
    const shell = argv[argv.length - 1]!
    expect(shell).toContain("tests/runtests.py 'queries.test'")
    expect(shell).not.toContain("pytest")
  })

  test("mount Windows C:\\x -> //c/x (di win32; passthrough di POSIX)", () => {
    const argv = buildDockerTestCommand({ image: "img", runner: "pytest" }, "C:\\tmp\\swe-1", ["t"])
    if (process.platform === "win32") expect(argv).toContain("//c/tmp/swe-1:/repo")
    else expect(argv).toContain("C:\\tmp\\swe-1:/repo")
    expect(dockerMountArg("/tmp/x")).toBe("/tmp/x")
  })

  test("install + test satu container: pip install -e . (+deps) && pytest", () => {
    // Filesystem container ephemeral per `docker run` — install terpisah
    // hilang sebelum pytest. Rantai sh -c WAJIB (bug nyata saat validasi).
    const argv = buildDockerTestCommand(
      { image: "minicode-swe:py36", runner: "pytest", deps: ["mpmath==1.0.0"] },
      "/tmp/x",
      ["a.py::T::t"],
    )
    expect(argv.slice(0, 7)).toEqual(["docker", "run", "--rm", "-v", "/tmp/x:/repo", "-w", "/repo"])
    expect(argv).toContain("minicode-swe:py36")
    const shell = argv[argv.length - 1]!
    expect(shell).toContain("pip install --no-cache-dir -e . 'mpmath==1.0.0'")
    expect(shell).toContain("python -m pytest 'a.py::T::t' -q")
    expect(shell.indexOf("pip install")).toBeLessThan(shell.indexOf("pytest"))
  })

  test("tanpa deps: tetap pip install -e . dulu", () => {
    const argv = buildDockerTestCommand({ image: "img", runner: "pytest", deps: [] }, "/tmp/x", [
      "t",
    ])
    const shell = argv[argv.length - 1]!
    expect(shell).toContain("pip install --no-cache-dir -e .")
  })

  test("manifest sympy membawa deps mpmath era", () => {
    const era = eraForInstance("sympy__sympy-11400")
    expect(era?.deps).toContain("mpmath==1.0.0")
  })

  test("marker SWE_INSTALL/SWE_TEST memisahkan install vs verdict", () => {
    const argv = buildDockerTestCommand({ image: "img", runner: "pytest" }, "/tmp/x", ["t"])
    const shell = argv[argv.length - 1]!
    expect(shell).toContain("echo SWE_INSTALL=$?")
    expect(shell).toContain("echo SWE_TEST=$?")
  })
})

describe("swebench interpretCodes: verdict vs harness error", () => {
  test("1+0 = unresolved (genuine fail), 0+0 = passed", () => {
    expect(interpretCodes({ installOk: true, code: 1 }, { installOk: true, code: 0 }, "i")).toEqual(
      { passed: false, failCode: 1, passCode: 0 },
    )
    expect(interpretCodes({ installOk: true, code: 0 }, { installOk: true, code: 0 }, "i")).toEqual(
      { passed: true, failCode: 0, passCode: 0 },
    )
  })

  test("install gagal / timeout / exit 2-5 = throw harness error (bukan FAIL model)", () => {
    expect(() =>
      interpretCodes({ installOk: false, code: 1 }, { installOk: true, code: 0 }, "i"),
    ).toThrow(/pip install failed/)
    expect(() =>
      interpretCodes({ installOk: true, code: null }, { installOk: true, code: 0 }, "i"),
    ).toThrow(/tak selesai/)
    // Kasus nyata sympy: collection error (exit 2) disangka FAIL model.
    expect(() =>
      interpretCodes({ installOk: true, code: 2 }, { installOk: true, code: 0 }, "i"),
    ).toThrow(/exit 2/)
    expect(() =>
      interpretCodes({ installOk: true, code: 1 }, { installOk: true, code: 5 }, "i"),
    ).toThrow(/exit 5/)
  })
})
