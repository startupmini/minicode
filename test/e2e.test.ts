import { expect, test } from "bun:test"
import { mkdir, readFile, rm } from "node:fs/promises"
import { createSession } from "#minicore/core/index.ts"
import { allowAll, FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { readFileTool } from "../src/tools/read_file.ts"
import { writeFileTool } from "../src/tools/write_file.ts"

const tmp = ".tmp-e2e"

test("e2e: full session — agent writes a file via tool, history committed", async () => {
  await mkdir(tmp, { recursive: true })
  const provider = new FakeProvider([
    // turn 1: agent memanggil write_file
    {
      events: [
        toolCall("write_file", { path: `${tmp}/out.txt`, content: "hello e2e" }),
        finish("tool_calls"),
      ],
    },
    // turn 2: agent menyimpulkan
    { events: [text("file created"), finish("stop")] },
  ])
  const session = createSession({
    provider,
    permissions: allowAll,
    tools: [writeFileTool],
    cwd: process.cwd(),
  } as never)
  const result = await session.run("write hello e2e to out.txt")
  expect(result.finalText).toBe("file created")
  expect(result.steps).toHaveLength(1)
  // file benar-benar dibuat oleh tool
  expect(await readFile(`${tmp}/out.txt`, "utf8")).toBe("hello e2e")
  // history berisi user + assistant(tool) + tool(result) + assistant(final)
  const history = session.state.history
  expect(
    history.some((m: any) => m.role === "tool" && m.toolCallId && m.name === "write_file"),
  ).toBe(true)
  await rm(tmp, { recursive: true, force: true })
})

test("e2e: read_file feeds content back to the model", async () => {
  await mkdir(tmp, { recursive: true })
  const { writeFile } = await import("node:fs/promises")
  await writeFile(`${tmp}/src.ts`, "export const x = 42;\n", "utf8")
  const provider = new FakeProvider([
    { events: [toolCall("read_file", { path: `${tmp}/src.ts` }), finish("tool_calls")] },
    { events: [text("done"), finish("stop")] },
  ])
  const session = createSession({
    provider,
    permissions: allowAll,
    tools: [readFileTool],
    cwd: process.cwd(),
  } as never)
  await session.run("read src.ts")
  // provider kedua menerima tool result berisi isi file
  const second = provider.requests[1]!
  const toolMsg = second.messages.find((m: any) => m.role === "tool")
  expect(toolMsg).toBeTruthy()
  expect(String((toolMsg as any).content)).toContain("export const x = 42")
  await rm(tmp, { recursive: true, force: true })
})

test("e2e: kernel emits live context (context-window) per step", async () => {
  await mkdir(tmp, { recursive: true })
  const provider = new FakeProvider([
    {
      events: [
        toolCall("write_file", { path: `${tmp}/out.txt`, content: "hi" }),
        finish("tool_calls"),
      ],
    },
    { events: [text("done"), finish("stop")] },
  ])
  const session = createSession({
    provider,
    permissions: allowAll,
    tools: [writeFileTool],
    cwd: process.cwd(),
  } as never)
  const seen: Array<{ usedTokens?: number; windowTokens?: number }> = []
  const off = session.events.on("provider:extension", (e: any) => {
    if (e.kind === "context-window") seen.push(e.data as never)
  })
  await session.run("write hi")
  off()
  // Satu step (tool call) → satu emit context-window SETELAH step selesai.
  expect(seen.length).toBeGreaterThan(0)
  expect(seen[0]!.usedTokens).toBeGreaterThan(0)
  expect(seen[0]!.windowTokens).toBeGreaterThan(0)
  await rm(tmp, { recursive: true, force: true })
})
