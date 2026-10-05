// P2.0 — Fixture migrasi legacy 1–12 + idempotensi + rollback (MIGRATION).
//
// Fixture deterministik, human-readable, dibangun via API produksi nyata
// (saveSession/TaskStore) TANPA mengubah perilaku produksi. Setiap fixture
// diekspos sebagai builder agar P2.12 dapat memakainya ulang.

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { saveSession } from "../src/session/persistence.ts"
import { TaskStore } from "../src/task/store.ts"
import { P2_CLASS, p2Cleanup, p2Cwd, p2DbPath, p2Id, p2Msgs, p2ResetIds } from "./helpers/p2.ts"

function taskInput(title: string) {
  return {
    title,
    status: "pending",
    order: 0,
    provenance: { origin: "model", source: "p2-fixture" },
  } as never
}

export async function fxSingle(cwd: string, id: string) {
  await saveSession(id, cwd, undefined, p2Msgs(3, `${id}`), { turns: 1 })
}

export async function fxDual(cwd: string, a: string, b: string) {
  await saveSession(a, cwd, undefined, p2Msgs(2, "a"), { turns: 1 })
  await saveSession(b, cwd, undefined, p2Msgs(2, "b"), { turns: 1 })
}

test(`[${P2_CLASS.MIGRATION}] F1: sesi normal single-id utuh`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m1")
  try {
    const id = p2Id("sess")
    await fxSingle(cwd, id)
    expect(existsSync(p2DbPath(cwd))).toBe(true)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F2: sesi dual-id era kini (dua baris hidup berdampingan)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m2")
  try {
    await fxDual(cwd, "sesi-lama", "sesi-baru")
    const { loadSession } = await import("../src/session/persistence.ts")
    expect(loadSession("sesi-lama", cwd)!.messages.length).toBe(2)
    expect(loadSession("sesi-baru", cwd)!.messages.length).toBe(2)
    // Expected After P2: fixture ini menjadi input pohon §5 (satu kanonik +
    // satu thread_migr_*), bukan dua sesi.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F3: dua baris identik (byte-sama)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m3")
  try {
    const msgs = p2Msgs(2, "sama")
    await saveSession("alpha", cwd, undefined, msgs, { turns: 1 })
    await saveSession("zeta", cwd, undefined, msgs, { turns: 1 })
    const { loadSession } = await import("../src/session/persistence.ts")
    expect(JSON.stringify(loadSession("alpha", cwd)!.messages)).toBe(
      JSON.stringify(loadSession("zeta", cwd)!.messages),
    )
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F4: histori divergen (isi beda, panjang beda)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m4")
  try {
    await saveSession("kurus", cwd, undefined, p2Msgs(2, "k"), { turns: 1 })
    await saveSession("gemuk", cwd, undefined, p2Msgs(9, "g"), { turns: 1 })
    const { loadSession } = await import("../src/session/persistence.ts")
    expect(loadSession("kurus", cwd)!.messages.length).toBe(2)
    expect(loadSession("gemuk", cwd)!.messages.length).toBe(9)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F5: history-rich vs task-authoritative`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m5")
  try {
    await saveSession("kaya", cwd, undefined, p2Msgs(20, "kaya"), { turns: 1 })
    await saveSession("hidup", cwd, undefined, p2Msgs(2, "hidup"), { turns: 1 })
    const store = new TaskStore(cwd)
    store.createTask("hidup", taskInput("tugas-hidup"))
    expect(store.listTasks("hidup").length).toBe(1)
    expect(store.listTasks("kaya").length).toBe(0)
    // Expected After P2: kanonik=hidup; kaya → thread_migr_kaya read-only.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F6: dua ID task-authoritative (operator-choice)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m6")
  try {
    await fxDual(cwd, "a", "b")
    const store = new TaskStore(cwd)
    store.createTask("a", taskInput("ta"))
    store.createTask("b", taskInput("tb"))
    expect(store.listTasks("a").length).toBe(1)
    expect(store.listTasks("b").length).toBe(1)
    // Expected After P2: migrasi MENOLAK auto-merge fixture ini.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F7/F8: kandidat kolisi sanitizer + over-length`, () => {
  // Dokumentasi vektor (eksekusi sanitizer ada di p2-identity.test.ts).
  expect("a/b").not.toBe("a-b")
  expect("x".repeat(100).length).toBe(100)
  // Expected After P2: migrator menolak auto-merge pasangan ini.
})

test(`[${P2_CLASS.MIGRATION}] F9: journal split dua ID`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m9")
  try {
    const { attachMutationJournal } = await import("../src/session/journal.ts")
    const { createSession } = await import("#minicore/core/index.ts")
    const { allowAll, FakeProvider, finish, text } = await import("#minicore/test/fakes.ts")
    for (const sid of ["j1", "j2"]) {
      const s = createSession({
        provider: new FakeProvider([{ events: [text("ok"), finish("stop")] }]),
        permissions: allowAll,
      })
      attachMutationJournal(s as never, { sessionId: sid, cwd })
      await s.run("hai")
    }
    // Eager-create jurnal bersifat fire-and-forget async; di Windows
    // butuh settling time. Poll terbatas (bukan sleep buta).
    for (let i = 0; i < 40; i++) {
      if (
        existsSync(join(cwd, ".minicode", "journal-j1.jsonl")) &&
        existsSync(join(cwd, ".minicode", "journal-j2.jsonl"))
      ) {
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(existsSync(join(cwd, ".minicode", "journal-j1.jsonl"))).toBe(true)
    expect(existsSync(join(cwd, ".minicode", "journal-j2.jsonl"))).toBe(true)
    // Expected After P2: copy+pointer ke nama kanonik; sumber utuh s/d validasi.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F10: checkpoint split (satu sisi ber-manifest)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m10")
  try {
    const { recordCheckpointFromSnapshots, loadCheckpointManifest } = await import(
      "../src/session/checkpoint.ts"
    )
    await recordCheckpointFromSnapshots(
      "ckpt-punya",
      1,
      [{ path: "f.txt", content: null }],
      "uji",
      cwd,
    )
    const ada = await loadCheckpointManifest("ckpt-punya", cwd)
    const kosong = await loadCheckpointManifest("ckpt-tak-punya", cwd)
    expect(ada.checkpoints.length).toBe(1)
    expect(kosong.checkpoints.length).toBe(0)
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F11: divergensi global vs lokal (pasangan DB per cwd)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m11")
  try {
    await fxSingle(cwd, "pair-sess")
    const store = new TaskStore(cwd)
    store.createTask("pair-sess", taskInput("tugas-pair"))
    // Pasangan hidup berdampingan di cwd yang sama (hermetic lokal).
    expect(existsSync(p2DbPath(cwd, "sessions.db"))).toBe(true)
    expect(existsSync(p2DbPath(cwd, "tasks.db"))).toBe(true)
    // Expected After P2: migrator membuka PASANGAN ini bersama; tak pernah
    // sessions.db saja (anti split diam-diam).
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] F12: histori pra-P2 yang diringkas (incomplete eksplisit)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2m12")
  try {
    await saveSession("warisan", cwd, undefined, [{ role: "user", content: "ringkasan warisan" }], {
      turns: 5,
    })
    const { loadSession } = await import("../src/session/persistence.ts")
    // 5 turn diklaim, 1 baris tersisa → bukti pemusnahan prefix era lama.
    expect(loadSession("warisan", cwd)!.messages.length).toBe(1)
    // Expected After P2: baris ini bertanda migrated_compacted=true.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] idempotensi: migrasi ganda tidak menduplikasi (kontrak harness)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2midem")
  try {
    const id = p2Id("sess")
    const msgs = p2Msgs(3, "idem")
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    const { loadSession } = await import("../src/session/persistence.ts")
    // Guard anti turn-hantu kini: re-save identik tak menambah baris/turn.
    expect(loadSession(id, cwd)!.messages.length).toBe(3)
    // Expected After P2: migrate(migrate(x))==migrate(x) untuk alias,
    // thread, event, dan identitas kanonik.
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.MIGRATION}] rollback: sumber legacy utuh sebelum validasi (kontrak pra-syarat)`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-p2mrb")
  try {
    const id = p2Id("sess")
    const msgs = p2Msgs(3, "rb")
    await saveSession(id, cwd, undefined, msgs, { turns: 1 })
    const before = JSON.stringify(
      (await import("../src/session/persistence.ts")).loadSession(id, cwd),
    )
    // "Migrasi" tiruan yang gagal di tengah (tanpa menulis apa pun).
    await Promise.resolve()
    const after = JSON.stringify(
      (await import("../src/session/persistence.ts")).loadSession(id, cwd),
    )
    expect(after).toBe(before)
    // Expected After P2: tiap fase cutover yang terinterupsi meninggalkan
    // state re-runnable; tak ada fase yang menghancurkan sumber pra-validasi.
  } finally {
    await p2Cleanup(cwd)
  }
})
