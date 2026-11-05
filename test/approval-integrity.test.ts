// PROMPT 06 · Area B — integritas persetujuan & proteksi TOCTOU.
//
// Yang dijaga (integration, bukan klaim):
// 1. Pratinjau approval MEWAKILI operasi nyata: skema argumen yang dipakai
//    preview (`oldString`/`newString`, `patches[]`) sama dengan skema tool.
// 2. TOCTOU TARGET lapis-1 (saat prompt): bila file target berubah di antara
//    preview/prompt dan keputusan user, operasi DITOLAK (approval basi) —
//    bukan dijalankan diam-diam.
// 3. TOCTOU TARGET lapis-2 (BATAS EKSEKUSI): bila file target berubah
//    SETELAH user menyetujui tapi SEBELUM tool dieksekusi (mis. saat intent
//    jurnal ditulis), operasi DITOLAK — tool tak pernah dijalankan.
// 4. File yang belum ada → tetap boleh (menulis file baru), tapi bila file
//    muncul setelah approval, operasi DITOLAK (menimpa isi lain).
// 5. Izin untuk satu operasi tak dipakai untuk operasi lain (hash argumen).
// 6. Store binding bersifat per-sesi: approval sesi A tak berlaku di sesi B.
//
// Test memakai tool NYATA (`editTool`, `writeFileTool`) + permission handler
// NYATA + sesi kernel NYATA — bukan mock. Layer-2 memakai sesi `createMinicodeSession`
// sungguhan dengan hook `beforeToolEffect` yang mengubah file saat barrier
// efek menunggu (jendela await yang nyata antara izin dan eksekusi).

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import {
  ApprovalBindingStore,
  captureApprovalBinding,
  verifyApprovalBinding,
} from "../src/policy/approval-binding.ts"
import { canPersistAlways, createPermissionHandler } from "../src/policy/permission.ts"
import { editTool } from "../src/tools/edit.ts"

const roots: string[] = []

afterEach(() => {
  for (const d of roots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-appr-"))
  roots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

/** Deps minimal untuk `PermissionHandler.check` (kernel hanya butuh bentuknya). */
function depsFor(cwd: string): never {
  return {
    registry: { get: () => undefined, list: () => [] },
    permissions: {} as never,
    events: { emit: () => {}, on: () => () => {} },
    signal: new AbortController().signal,
    state: { messages: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 1000,
    cwd,
  } as never
}

describe("Area B: preview approval Mewakili operasi nyata", () => {
  test("pratinjau edit memakai oldString/newString (skema tool), bukan nama lama", async () => {
    const dir = ws()
    let seen: { riskTier?: string; diffPreview?: string } | undefined
    const handler = createPermissionHandler({
      mode: "ask",
      root: dir,
      ask: async (call) => {
        seen = { riskTier: call.riskTier, diffPreview: call.diffPreview }
        return "allow"
      },
    })
    const decision = await handler.check(
      {
        id: "c1",
        name: "edit",
        args: { path: "a.ts", oldString: "const lama = 1", newString: "const baru = 2" },
      } as never,
      depsFor(dir),
    )
    expect(decision).toBe("allow")
    expect(seen?.diffPreview).toContain("a.ts")
    expect(seen?.diffPreview).toContain("const lama = 1")
    expect(seen?.diffPreview).toContain("const baru = 2")
  })

  test("pratinjau apply_patch memakai patches[] (skema tool)", async () => {
    const dir = ws()
    let seen: { diffPreview?: string } | undefined
    const handler = createPermissionHandler({
      mode: "ask",
      root: dir,
      ask: async (call) => {
        seen = { diffPreview: call.diffPreview }
        return "allow"
      },
    })
    await handler.check(
      {
        id: "c2",
        name: "apply_patch",
        args: {
          path: "b.ts",
          patches: [{ search: "lama", replace: "baru" }],
        },
      } as never,
      depsFor(dir),
    )
    expect(seen?.diffPreview).toContain("b.ts")
    expect(seen?.diffPreview).toContain("lama")
    expect(seen?.diffPreview).toContain("baru")
  })
})

describe("Area B: TOCTOU target ditolak saat prompt (lapis-1)", () => {
  test("file target berubah saat prompt terbuka → operasi basi DITOLAK", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    const store = new ApprovalBindingStore(dir)
    const handler = createPermissionHandler({
      mode: "ask",
      root: dir,
      approvalBindings: store,
      // Adversarial: file berubah SELAMA prompt terbuka (proses lain/user).
      ask: async () => {
        writeFileSync(file, "const lain = 99\n", "utf8")
        return "allow"
      },
    })

    const decision = await handler.check(
      {
        id: "c1",
        name: "edit",
        args: { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
      } as never,
      depsFor(dir),
    )
    expect(decision).toBe("deny")
    expect(handler.describeDenial?.({ id: "c1" } as never)).toContain("approval stale")
    // Tidak ada binding yang tertinggal (tak ada izin untuk operasi basi).
    expect(store.size).toBe(0)
    // File tak berubah oleh kita.
    expect(readFileSync(file, "utf8")).toBe("const lain = 99\n")
  })

  test("file target tak berubah → operasi yang disetujui tetap berjalan", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    const store = new ApprovalBindingStore(dir)
    const handler = createPermissionHandler({
      mode: "ask",
      root: dir,
      approvalBindings: store,
      ask: async () => "allow",
    })
    const decision = await handler.check(
      {
        id: "c1",
        name: "edit",
        args: { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
      } as never,
      depsFor(dir),
    )
    expect(decision).toBe("allow")
    // Bukti persetujuan tersimpan untuk diverifikasi di batas eksekusi.
    expect(store.size).toBe(1)
  })

  test("file baru: boleh menulis bila target tetap absen; ditolak bila muncul setelah approval", async () => {
    const dir = ws()
    const file = join(dir, "baru.ts")

    // (a) target tetap absen → boleh.
    {
      const store = new ApprovalBindingStore(dir)
      const handler = createPermissionHandler({
        mode: "ask",
        root: dir,
        approvalBindings: store,
        ask: async () => "allow",
      })
      const decision = await handler.check(
        { id: "c1", name: "write_file", args: { path: file, content: "isi\n" } } as never,
        depsFor(dir),
      )
      expect(decision).toBe("allow")
      expect(store.size).toBe(1)
    }

    // (b) file muncul setelah approval → menimpa isi lain = operasi basi.
    {
      const dir2 = ws()
      const file2 = join(dir2, "baru.ts")
      const store = new ApprovalBindingStore(dir2)
      const handler = createPermissionHandler({
        mode: "ask",
        root: dir2,
        approvalBindings: store,
        ask: async () => {
          writeFileSync(file2, "isi milik orang lain\n", "utf8")
          return "allow"
        },
      })
      const decision = await handler.check(
        { id: "c2", name: "write_file", args: { path: file2, content: "isi\n" } } as never,
        depsFor(dir2),
      )
      expect(decision).toBe("deny")
      expect(readFileSync(file2, "utf8")).toBe("isi milik orang lain\n")
    }
  })
})

describe("Area B: TOCTOU target ditolak di BATAS EKSEKUSI (lapis-2, integrasi kernel)", () => {
  test("file berubah saat barrier efek menunggu → tool TAK dijalankan", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    // Sesi kernel NYATA. `beforeToolEffect` menulis intent jurnal secara
    // awaited — persis jendela await antara izin dan eksekusi tool.
    const provider = new FakeProvider([
      {
        events: [
          toolCall(
            "edit",
            { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
            "call-1",
          ),
          finish("tool_calls"),
        ],
      },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [editTool],
      cwd: dir,
      permissionMode: "ask",
      ask: async () => "allow",
      beforeToolEffect: async () => {
        // Proses lain mengubah file SETELAH user menyetujui.
        writeFileSync(file, "const diubah = 3\n", "utf8")
      },
    })

    const result = await session.run("edit a.ts")
    // Tool tak pernah dieksekusi → isi file tetap milik "proses lain".
    expect(readFileSync(file, "utf8")).toBe("const diubah = 3\n")
    // Hasil turn memuat penolakan yang bisa ditindaklanjuti.
    const texts = JSON.stringify(result.steps)
    expect(texts).toContain("approval stale")
  })

  test("file tak berubah → tool dijalankan normal (tak ada false-deny)", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    const provider = new FakeProvider([
      {
        events: [
          toolCall(
            "edit",
            { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
            "call-1",
          ),
          finish("tool_calls"),
        ],
      },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [editTool],
      cwd: dir,
      permissionMode: "ask",
      ask: async () => "allow",
      beforeToolEffect: async () => {
        // Tidak mengubah apa pun — hanya menahan sebentar.
        await new Promise((r) => setTimeout(r, 1))
      },
    })

    await session.run("edit a.ts")
    expect(readFileSync(file, "utf8")).toContain("const baru = 2")
  })
})

describe("Area B: izin tak lintas operasi / tak lintas sesi", () => {
  test("approval untuk file A tak mengizinkan file B", async () => {
    const dir = ws()
    const fileA = join(dir, "a.ts")
    const fileB = join(dir, "b.ts")
    writeFileSync(fileA, "lama\n", "utf8")
    writeFileSync(fileB, "lama\n", "utf8")

    const store = new ApprovalBindingStore(dir)
    const handler = createPermissionHandler({
      mode: "ask",
      root: dir,
      approvalBindings: store,
      ask: async () => "allow",
    })
    const argsA = { path: fileA, oldString: "lama", newString: "baru" }
    const argsB = { path: fileB, oldString: "lama", newString: "baru" }
    expect(
      await handler.check({ id: "c1", name: "edit", args: argsA } as never, depsFor(dir)),
    ).toBe("allow")
    // Call dengan argumen BERBEDA (file lain) → hash argumen beda → bukti
    // milik call pertama TIDAK boleh dipakai untuk call kedua.
    expect(
      await handler.check({ id: "c2", name: "edit", args: argsB } as never, depsFor(dir)),
    ).toBe("allow")
    expect(store.size).toBe(2)
  })

  test("store sesi A tak dipakai sesi B", () => {
    const storeA = new ApprovalBindingStore("/tmp/a")
    const storeB = new ApprovalBindingStore("/tmp/b")
    storeA.grant(captureApprovalBinding("edit", { path: "x.ts" }, "/tmp/a"))
    expect(storeA.size).toBe(1)
    expect(storeB.size).toBe(0)
    expect(storeB.take("edit", "hash")).toBeUndefined()
    expect(storeA.size).toBe(1)
  })

  test("verifikasi: binding dengan target tak berubah → ok; berubah → stale", () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "isi\n", "utf8")
    const binding = captureApprovalBinding("write_file", { path: file, content: "x" }, dir)
    expect(verifyApprovalBinding(binding).kind).toBe("ok")
    writeFileSync(file, "isi lain\n", "utf8")
    const verdict = verifyApprovalBinding(binding)
    expect(verdict.kind).toBe("stale")
    // Tak ada binding → tak ada yang bisa diverifikasi (tak ada bukti basi).
    expect(verifyApprovalBinding(undefined).kind).toBe("no-binding")
  })
})

describe("P1.2: opsi always hanya ditawarkan bila dapat dipersist", () => {
  test("args kecil boleh; args > 2 KB ditolak (fail-closed)", () => {
    expect(canPersistAlways({ path: "a.ts", content: "kecil" })).toBe(true)
    expect(canPersistAlways({ path: "a.ts", content: "x".repeat(2_001) })).toBe(false)
    // Nilai yang tak bisa diserialisasi juga tidak boleh menjanjikan always.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(canPersistAlways(circular)).toBe(false)
  })
})
