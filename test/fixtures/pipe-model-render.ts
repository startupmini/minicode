// Fixture uji pipe F2: render satu turn model ber-SGR ke stdout yang di-pipe.
// Dijalankan sebagai proses anak (spawnSync, stdout tertangkap) sehingga
// process.stdout.isTTY === false di dalamnya — kebijakan non-TTY asli.
import { attachSimpleLogger } from "../../src/ui/assistant/simple.ts"

const handlers = new Map<string, ((e: never) => void)[]>()
const bus = {
  on(type: string, h: (e: never) => void): () => void {
    const list = handlers.get(type) ?? []
    list.push(h)
    handlers.set(type, list)
    return () => {}
  },
}

const detach = attachSimpleLogger(bus, {})
for (const h of handlers.get("turn:started") ?? []) h({ turn: 0 } as never)
for (const h of handlers.get("provider:text") ?? []) {
  h({ text: "\x1b[31mRed\x1b[0m\n" } as never)
  h({ text: "polos\n" } as never)
}
for (const h of handlers.get("turn:completed") ?? []) h({} as never)
detach()
