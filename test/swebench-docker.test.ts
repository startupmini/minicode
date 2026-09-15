import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  buildDockerTestCommand,
  dockerMountArg,
  eraForInstance,
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
  test("pytest runner: mount + workdir + image + test", () => {
    const argv = buildDockerTestCommand(
      { image: "minicode-swe:py39", runner: "pytest" },
      "/tmp/x",
      ["a.py::T::t"],
    )
    expect(argv.slice(0, 7)).toEqual(["docker", "run", "--rm", "-v", "/tmp/x:/repo", "-w", "/repo"])
    expect(argv).toContain("minicode-swe:py39")
    expect(argv.slice(-5)).toEqual(["python", "-m", "pytest", "a.py::T::t", "-q"])
  })

  test("django runner memakai tests/runtests.py", () => {
    const argv = buildDockerTestCommand(
      { image: "minicode-swe:py37", runner: "django" },
      "/tmp/x",
      ["queries.test"],
    )
    expect(argv).toContain("tests/runtests.py")
    expect(argv).not.toContain("pytest")
  })

  test("mount Windows C:\\x -> //c/x (di win32; passthrough di POSIX)", () => {
    const argv = buildDockerTestCommand({ image: "img", runner: "pytest" }, "C:\\tmp\\swe-1", ["t"])
    if (process.platform === "win32") expect(argv).toContain("//c/tmp/swe-1:/repo")
    else expect(argv).toContain("C:\\tmp\\swe-1:/repo")
    expect(dockerMountArg("/tmp/x")).toBe("/tmp/x")
  })
})
