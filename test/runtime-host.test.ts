// M3 — RuntimeHost facade: delegasi-only, tanpa second runtime.
// Hermetic: delegate fake berbentuk kontrak run existing (input + {signal}).

import { expect, test } from "bun:test"
import { createRuntimeHost } from "../src/runtime/runtime-host.ts"

function startedHost(opts: Parameters<typeof createRuntimeHost>[0] = {}) {
  const host = createRuntimeHost(opts)
  host.start()
  return host
}

// H1 — Construction
test("H1 construction: host valid + registry sendiri bila tak diinjeksi", () => {
  const host = createRuntimeHost()
  const m = host.metrics().host
  expect(m.started).toBe(false)
  expect(m.closed).toBe(false)
  host.start()
  expect(host.metrics().host.started).toBe(true)
  host.start() // idempoten, bukan double-init
  expect(host.metrics().host.started).toBe(true)
})

// H2 — Delegation: hasil identik, input + sinyal diteruskan
test("H2 delegation: run() = perilaku delegate existing, verbatim", async () => {
  const host = startedHost()
  const seen: unknown[] = []
  const out = await host.run("prompt-1", {
    runner: (async (input: unknown, o: { signal?: AbortSignal }) => {
      seen.push([input, o.signal instanceof AbortSignal || o.signal === undefined])
      return { ok: true, echo: input }
    }) as never,
  })
  expect(out).toEqual({ ok: true, echo: "prompt-1" })
  expect(seen).toEqual([["prompt-1", true]])
})

// H3 — Start guard
test("H3 start: admit/run sebelum start ditolak (bukan diam)", () => {
  const host = createRuntimeHost()
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  expect(() => host.run("x", { runner: (() => Promise.resolve(1)) as never })).toThrow()
  expect(host.inspect("exec_00000000-0000-4000-8000-000000000000")).toBeUndefined()
  expect(host.list()).toEqual([])
})

// H4 — Close idempoten
test("H4 close: onClose sekali; close ganda no-op; operasi sesudah close ditolak", async () => {
  let closes = 0
  const host = createRuntimeHost({
    hooks: {
      onClose: () => {
        closes++
      },
    },
  })
  host.start()
  await host.close()
  await host.close()
  expect(closes).toBe(1)
  expect(host.metrics().host.closes).toBe(1)
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  expect(() => host.start()).toThrow()
})

// H5 — Error propagation: exception/error delegate terlihat utuh
test("H5 error: reject diteruskan identik (tanpa retry, tanpa success-ifikasi)", async () => {
  const host = startedHost()
  const boom = new Error("provider down")
  let calls = 0
  await expect(
    host.run("x", {
      runner: (() => {
        calls++
        return Promise.reject(boom)
      }) as never,
    }),
  ).rejects.toBe(boom)
  expect(calls).toBe(1)
  expect(host.metrics().host.runErrors).toBe(1)
})

// H6/H7/H8/H9 — Equivalence mode: TUI/one-shot/exec/ACP berbentuk kontrak sama
for (const mode of ["tui-turn", "one-shot", "exec-json", "acp-run"] as const) {
  test(`H-equivalence ${mode}: BEFORE langsung vs AFTER via host — hasil/error/cancel sama`, async () => {
    const delegate = async (input: string, o: { signal?: AbortSignal }) => {
      o.signal?.throwIfAborted()
      if (input === "fail") throw new Error(`${mode} failed`)
      return { mode, result: `done:${input}`, code: 0 }
    }
    const before = await delegate("hi", {})
    const host = startedHost()
    const after = await host.run("hi", { runner: delegate })
    expect(after).toEqual(before)
    // Error equivalence (exit-code-like payload tetap verbatim).
    const errBefore = await delegate("fail", {}).then(
      () => null,
      (e: Error) => e.message,
    )
    const errAfter = await host.run("fail", { runner: delegate }).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(errAfter).toBe(errBefore)
    // Cancellation equivalence: sinyal milik caller, host tak menelan.
    const ctl = new AbortController()
    ctl.abort(new Error("user abort"))
    await expect(host.run("hi", { runner: delegate, signal: ctl.signal })).rejects.toThrow(
      "user abort",
    )
  })
}

// Tanpa runner terikat = throw LOUD (tak pernah mengarang execution).
test("H-no-delegate: run tanpa runner = loud error, bukan execution palsu", async () => {
  const host = startedHost()
  await expect(host.run("x")).rejects.toThrow("no runner bound")
  const bound = startedHost({ runner: ((v: string) => Promise.resolve(v)) as never })
  expect(await bound.run<string, string>("y")).toBe("y")
})

// H10 — Registry: host hanya observe/inspect
test("H10 registry: admit terobservasi; inspect frozen; shutdown latch", async () => {
  const host = startedHost()
  const c = host.admit({ kind: "turn", ownerId: "sess-9" })
  expect(host.inspect(c.executionId)?.stateSnapshot).toBe("ADMITTED")
  expect(host.list().length).toBe(1)
  expect(() => host.admit({ kind: "turn", ownerId: "" })).toThrow()
  const shut = await host.shutdown()
  expect(shut.shutdownRequested).toBe(true)
  expect(() => host.admit({ kind: "turn", ownerId: "sess-9" })).toThrow()
  // shutdown hook sekali; in-flight run tak dibatalkan host (bukan authority).
  let downs = 0
  const h2 = createRuntimeHost({
    hooks: {
      onShutdown: () => {
        downs++
      },
    },
  })
  h2.start()
  await h2.shutdown()
  await h2.shutdown()
  expect(downs).toBe(1)
})

// H11 — No authority: API lifecycle otoritatif tak ada
test("H11 no authority: setState/complete/fail/cancel-by-mutation tak tersedia", () => {
  const host = startedHost()
  const api = host as unknown as Record<string, unknown>
  for (const forbidden of [
    "setState",
    "complete",
    "fail",
    "cancel",
    "timeout",
    "transition",
    "commitTerminal",
    "claim",
    "release",
    "persist",
    "save",
    "kill",
    "terminate",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  host.admit({ kind: "task", ownerId: "t1" })
})

// H12 — Dependency isolation: tanpa import infra konkret
test("H12 isolation: host hanya bergantung observation plane (M1/M2)", async () => {
  const src = await Bun.file("src/runtime/runtime-host.ts").text()
  for (const forbidden of [
    "bun:sqlite",
    "session/journal",
    "session/persistence",
    "session/checkpoint",
    "ui/",
    "cli/",
    "task/scheduler",
    "task/store",
    "child_process",
    "sandbox",
    "permission",
    "#minicore",
  ]) {
    expect(src.includes(forbidden), forbidden).toBe(false)
  }
  expect(src.includes("execution-id")).toBe(true)
  expect(src.includes("execution-registry")).toBe(true)
})

// Observability minimal (bukan taksonomi M10)
test("H-metrics: created/started/run/close/error counted", async () => {
  const host = startedHost()
  host.admit({ kind: "background", ownerId: "s" })
  await host.run("a", { runner: (() => Promise.resolve(1)) as never })
  await host.run("b", { runner: (() => Promise.reject(new Error("x"))) as never }).catch(() => {})
  const m = host.metrics().host
  expect(m.admitted).toBe(1)
  expect(m.runs).toBe(2)
  expect(m.runErrors).toBe(1)
  expect(m.registryEntries).toBe(1)
  await host.close()
  expect(host.metrics().host.closed).toBe(true)
})

// Observability minimal (bukan taksonomi M10)
test("H-metrics: created/started/run/close/error counted", async () => {
  const host = startedHost()
  host.admit({ kind: "background", ownerId: "s" })
  await host.run("a", { runner: (() => Promise.resolve(1)) as never })
  await host.run("b", { runner: (() => Promise.reject(new Error("x"))) as never }).catch(() => {})
  const m = host.metrics().host
  expect(m.admitted).toBe(1)
  expect(m.runs).toBe(2)
  expect(m.runErrors).toBe(1)
  expect(m.registryEntries).toBe(1)
  await host.close()
  expect(host.metrics().host.closed).toBe(true)
})

// ── M4 — Host FSM: STARTING→READY→DRAINING→CLOSING→CLOSED (host, bukan execution) ──

test("M4-state: rantai penuh + state() observasi", async () => {
  const { createRuntimeHost } = await import("../src/runtime/runtime-host.ts")
  const host = createRuntimeHost()
  expect(host.state()).toBe("CREATED")
  host.start()
  expect(host.state()).toBe("READY")
  expect(host.metrics().host.state).toBe("READY")
  expect(host.metrics().host.startCount).toBe(1)
  await host.shutdown()
  expect(host.state()).toBe("DRAINING")
  await host.close()
  expect(host.state()).toBe("CLOSED")
})

// R1 start+start: no-op deterministik, tanpa double-init
test("M4-R1 start+start: kedua sukses, startCount 1", () => {
  const host = startedHost()
  host.start()
  expect(host.state()).toBe("READY")
  expect(host.metrics().host.startCount).toBe(1)
})

// R2 admit+shutdown: latch sinkron — admit sesudah shutdown ditolak + dihitung
test("M4-R2 admit+shutdown: admit pasca-shutdown ditolak deterministik", async () => {
  const host = startedHost()
  host.admit({ kind: "turn", ownerId: "s" })
  await host.shutdown()
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  expect(host.metrics().host.admissionRejectedDuringDrain).toBe(1)
  expect(host.state()).toBe("DRAINING")
})

// R3 shutdown+shutdown: hook sekali, count naik, tetap DRAINING
test("M4-R3 shutdown+shutdown: idempoten, hook sekali", async () => {
  let downs = 0
  const host = createRuntimeHost({
    hooks: {
      onShutdown: () => {
        downs++
      },
    },
  })
  host.start()
  await host.shutdown()
  await host.shutdown()
  expect(downs).toBe(1)
  expect(host.metrics().host.shutdowns).toBe(2)
  expect(host.state()).toBe("DRAINING")
})

// R4 shutdown+close: DRAINING→CLOSING→CLOSED, hook masing-masing sekali
test("M4-R4 shutdown+close: rantai tertib, tanpa double-cleanup", async () => {
  const order: string[] = []
  const host = createRuntimeHost({
    hooks: {
      onShutdown: () => {
        order.push("shutdown")
      },
      onClose: () => {
        order.push("close")
      },
    },
  })
  host.start()
  await host.shutdown()
  await host.close()
  expect(order).toEqual(["shutdown", "close"])
  expect(host.state()).toBe("CLOSED")
})

// R5 close+close: no-op join, hook sekali
test("M4-R5 close+close: idempoten penuh", async () => {
  let closes = 0
  const host = createRuntimeHost({
    hooks: {
      onClose: () => {
        closes++
      },
    },
  })
  host.start()
  await host.close()
  await host.close()
  await host.close()
  expect(closes).toBe(1)
  expect(host.state()).toBe("CLOSED")
})

// R6 shutdown+admit (urutan terbalik R2): sama deterministik
test("M4-R6 shutdown lalu admit: ditolak + dihitung", async () => {
  const host = startedHost()
  const p = host.shutdown()
  // admit() dipanggil SETELAH shutdown() dimulai (latch sudah set sinkron).
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  await p
  expect(host.metrics().host.admissionRejectedDuringDrain).toBe(1)
})

// R7 close+admit: CLOSED menolak segalanya
test("M4-R7 close+admit: ditolak deterministik", async () => {
  const host = startedHost()
  await host.close()
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  expect(() => host.run("x", { runner: (() => Promise.resolve(1)) as never })).toThrow()
})

// R8 start+close: CREATED→READY→CLOSED langsung (tanpa shutdown) valid
test("M4-R8 start+close tanpa shutdown: CLOSED deterministik", async () => {
  const host = startedHost()
  await host.close()
  expect(host.state()).toBe("CLOSED")
  expect(() => host.start()).toThrow()
})

// R9 shutdown + in-flight run: delegate tak tersentuh, hasil tetap terkirim
test("M4-R9 shutdown + in-flight: promise jalan terus, host tak cancel", async () => {
  const host = startedHost()
  let release!: (v: string) => void
  const pending = new Promise<string>((res) => {
    release = res
  })
  const flight = host.run("long", { runner: (() => pending) as never })
  await host.shutdown()
  expect(host.state()).toBe("DRAINING")
  release("done-late")
  expect(await flight).toBe("done-late")
})

// R10 close + in-flight run: sama — host tak membatalkan, tak menunggu
test("M4-R10 close + in-flight: close tak menggantung pada delegate", async () => {
  const host = startedHost()
  let release!: (v: string) => void
  const pending = new Promise<string>((res) => {
    release = res
  })
  const flight = host.run("long", { runner: (() => pending) as never })
  await host.close()
  expect(host.state()).toBe("CLOSED")
  release("done-after-close")
  expect(await flight).toBe("done-after-close")
})

// Startup failure: onStart throw = tetap CREATED, error propagates, retry mungkin
test("M4-startup-failure: gagal init tak pernah READY; retry diizinkan", () => {
  let fail = true
  let hooks = 0
  const host = createRuntimeHost({
    hooks: {
      onStart: () => {
        hooks++
        if (fail) throw new Error("init broken")
      },
    },
  })
  expect(() => host.start()).toThrow("init broken")
  expect(host.state()).toBe("CREATED")
  expect(host.metrics().host.startCount).toBe(0)
  fail = false
  host.start()
  expect(host.state()).toBe("READY")
  expect(hooks).toBe(2)
})

// Reentrant start dalam onStart ditolak deterministik (tanpa rekursi)
test("M4-reentrant: start() dalam onStart throw", () => {
  let host!: ReturnType<typeof createRuntimeHost>
  host = createRuntimeHost({ hooks: { onStart: () => host.start() } })
  expect(() => host.start()).toThrow()
  expect(host.state()).toBe("CREATED")
})

// Close failure: degraded + tetap CLOSED, tak resurrect; close lagi no-op
test("M4-close-failure: hook gagal = degraded CLOSED, tanpa resurrection", async () => {
  let closes = 0
  const host = createRuntimeHost({
    hooks: {
      onClose: () => {
        closes++
        throw new Error("cleanup broken")
      },
    },
  })
  host.start()
  await expect(host.close()).rejects.toThrow("close hook failed")
  expect(host.state()).toBe("CLOSED")
  expect(host.metrics().host.hookFailures).toBe(1)
  await host.close()
  expect(closes).toBe(1)
  expect(host.state()).toBe("CLOSED")
})

// Shutdown hook gagal: tetap DRAINING, degraded, tak resurrect ke READY
test("M4-shutdown-failure: hook gagal = degraded DRAINING", async () => {
  const host = createRuntimeHost({
    hooks: {
      onShutdown: () => {
        throw new Error("drain broken")
      },
    },
  })
  host.start()
  await host.shutdown()
  expect(host.state()).toBe("DRAINING")
  expect(host.metrics().host.hookFailures).toBe(1)
  await host.close()
  expect(host.state()).toBe("CLOSED")
})

// Hook timeout: bound konservatif, bukan hang tanpa batas
test("M4-hook-timeout: hook gantung diputus bound + degraded", async () => {
  const host = createRuntimeHost({
    hooks: { onShutdown: () => new Promise<void>(() => {}) },
    shutdownHookTimeoutMs: 50,
  })
  host.start()
  const t0 = Date.now()
  await host.shutdown()
  const dt = Date.now() - t0
  expect(dt).toBeLessThan(5000)
  expect(host.state()).toBe("DRAINING")
  expect(host.metrics().host.hookFailures).toBe(1)
  expect(host.metrics().host.lastShutdownDurationMs).not.toBeNull()
})

// Negative authority: host tak memiliki execution terminal authority
test("M4-no-execution-authority: host tak putuskan COMPLETED/FAILED/CANCELLED", () => {
  const host = startedHost()
  const api = host as unknown as Record<string, unknown>
  for (const forbidden of [
    "complete",
    "fail",
    "cancelExecution",
    "timeoutExecution",
    "transition",
    "commitTerminal",
    "setExecutionState",
  ]) {
    expect(api[forbidden], forbidden).toBeUndefined()
  }
  // State host TERPISAH dari state execution: admit mencatat observasi "ADMITTED"
  // label snapshot, bukan keputusan lifecycle (otoritas = Kernel M8).
  const c = host.admit({ kind: "turn", ownerId: "s" })
  expect(host.state()).toBe("READY")
  expect(host.inspect(c.executionId)?.stateSnapshot).toBe("ADMITTED")
})

// Signal seam: shutdown()/close() aman dari callback sinyal (ganda = aman)
test("M4-signal-seam: double-delivery sinyal deterministik", async () => {
  const host = startedHost()
  const onSigterm = () => host.shutdown().then(() => host.close())
  const onSigterm2 = () => host.shutdown().catch(() => host.close())
  await onSigterm()
  // Delivery kedua: shutdown() di CLOSING/CLOSED melempar → fallback close() no-op.
  await onSigterm2()
  expect(host.state()).toBe("CLOSED")
})

// Observability FSM: state + counter + durasi terekspos
test("M4-observability: state/count/reject/hook-failure/duration", async () => {
  const host = startedHost()
  expect(host.metrics().host.state).toBe("READY")
  await host.shutdown()
  expect(() => host.admit({ kind: "turn", ownerId: "s" })).toThrow()
  await host.close()
  const m = host.metrics().host
  expect(m.state).toBe("CLOSED")
  expect(m.shutdowns).toBe(1)
  expect(m.closes).toBe(1)
  expect(m.admissionRejectedDuringDrain).toBe(1)
  expect(m.hookFailures).toBe(0)
  expect(m.lastShutdownDurationMs).not.toBeNull()
  expect(m.lastCloseDurationMs).not.toBeNull()
})
