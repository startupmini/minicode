import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isPathOutsideRoot } from "../src/policy/jail.ts"

export interface BenchTask {
  id: string
  description: string
  setup(): Promise<string>
  prompt: string
  verify(dir: string): Promise<{ passed: boolean; detail: string }>
  cleanup(dir: string): Promise<void>
  /**
   * Fakta yang di-seed ke memory global SEBELUM run (hanya bila eval jalan
   * dengan memory on) — untuk mengukur nilai memory secara diferensial:
   * task lolos HANYA bila agen membaca fakta ini. Tanpa seed (atau memory
   * off), agen tak punya jalan mengetahuinya.
   */
  seedMemory?: string
}

const clean = (dir: string) => rm(dir, { recursive: true, force: true }).catch(() => {})

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "create-function",
    description: "Create a greet() function in a TS file",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(join(dir, "greet.ts"), "", "utf8")
      return dir
    },
    prompt:
      "Create a function `greet(name: string): string` that returns `Hello, <name>!` in greet.ts. Use write_file. Write the full file.",
    async verify(dir) {
      const txt = await readFile(join(dir, "greet.ts"), "utf8").catch(() => "")
      return {
        passed: /function\s+greet\s*\(/.test(txt) && /Hello/.test(txt),
        detail: txt.slice(0, 160),
      }
    },
    cleanup: clean,
  },
  {
    id: "fix-bug",
    description: "Fix a broken sum() (subtracts instead of adds)",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "sum.ts"),
        "export function sum(a: number[]): number {\n  let t = 0;\n  for (let i = 0; i < a.length; i++) {\n    t -= a[i]!;\n  }\n  return t;\n}\n",
        "utf8",
      )
      return dir
    },
    prompt: "The sum function is wrong (it subtracts). Fix it to add the elements. Edit sum.ts.",
    async verify(dir) {
      const txt = await readFile(join(dir, "sum.ts"), "utf8").catch(() => "")
      return { passed: /t\s*\+=/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
  {
    id: "write-test",
    description: "Write a unit test for an existing function",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "add.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Write a bun:test unit test for add() in add.test.ts that checks add(2,3) === 5. Use write_file.",
    async verify(dir) {
      const txt = await readFile(join(dir, "add.test.ts"), "utf8").catch(() => "")
      return { passed: /add\s*\(2\s*,\s*3\)|toBe\s*\(\s*5/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
  {
    id: "follow-convention",
    description: "Follow a project convention known only from memory",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(join(dir, "greet.ts"), "", "utf8")
      return dir
    },
    // Sengaja TAK menyebut nama fungsinya: satu-satunya jalan tahu adalah
    // fakta seedMemory di bawah (dibaca via RAG bila memory on). Dulu prompt
    // menyebut `f(name: string)` yang MENGANGKER nama `f` dan bertabrakan
    // dengan konvensi `salam` — diferensial memory jadi tak terukur (model
    // ikut prompt, bukan memori). Prompt kini netral terhadap nama.
    prompt:
      "Create the standard project greeting function in greet.ts. Use write_file. Write the full file.",
    seedMemory:
      "Project convention: the standard greeting function MUST be named `salam` (never `greet`, `hello`, or `hi`).",
    async verify(dir) {
      const txt = await readFile(join(dir, "greet.ts"), "utf8").catch(() => "")
      return {
        passed: /function\s+salam\s*\(/.test(txt) && !/function\s+greet\s*\(/.test(txt),
        detail: txt.slice(0, 160),
      }
    },
    cleanup: clean,
  },
  {
    id: "rename-symbol",
    description: "Rename a function across a file",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "util.ts"),
        "export function calcOld(a: number): number { return a * 2; }\nconst res = calcOld(5);\nexport { res };\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Rename function `calcOld` to `calc` everywhere in util.ts, and update the call site. Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "util.ts"), "utf8").catch(() => "")
      return { passed: /calc\b/.test(txt) && !/calcOld/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
  {
    id: "add-error-handling",
    description: "Add error handling to a fetch wrapper",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "client.ts"),
        "export async function getJson(url: string): Promise<unknown> {\n  const res = await fetch(url);\n  return res.json();\n}\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Add error handling to getJson() in client.ts: throw on !res.ok, wrap in try/catch. Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "client.ts"), "utf8").catch(() => "")
      return { passed: /res\.ok|try\s*\{|catch/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
  {
    id: "multi-file-refactor",
    description: "Move a helper across two files",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "a.ts"),
        "export function helper(n: number): number {\n  return n + 1;\n}\n",
        "utf8",
      )
      await writeFile(
        join(dir, "b.ts"),
        "import { helper } from './a.ts';\nexport const result = helper(1);\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Move helper() from a.ts into b.ts, and update the import in b.ts so it stays exported from b.ts (remove from a.ts). Use edit/write_file.",
    async verify(dir) {
      const a = await readFile(join(dir, "a.ts"), "utf8").catch(() => "")
      const b = await readFile(join(dir, "b.ts"), "utf8").catch(() => "")
      return {
        passed: !/function\s+helper/.test(a) && /export function helper|export\s+\{|helper/.test(b),
        detail: `a=${a.slice(0, 60)} b=${b.slice(0, 60)}`,
      }
    },
    cleanup: clean,
  },
  {
    id: "config-type",
    description: "Add a config type with zod-free validation",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "config.ts"),
        "export interface Config { port: number; host: string }\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Write a function validateConfig(cfg: unknown): Config in config.ts (types only, no zod) that throws if type mismatches. Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "config.ts"), "utf8").catch(() => "")
      return {
        passed: /function\s+validateConfig|export\s+function\s+validateConfig/.test(txt),
        detail: txt.slice(0, 160),
      }
    },
    cleanup: clean,
  },
  {
    id: "comment-docs",
    description: "Add doc comments to a public API",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "math.ts"),
        "export function mul(a: number, b: number): number {\n  return a * b;\n}\n\nexport function div(a: number, b: number): number {\n  if (b === 0) throw new Error('div by zero');\n  return a / b;\n}\n",
        "utf8",
      )
      return dir
    },
    prompt: "Add JSDoc doc comments (param + return) to mul() and div() in math.ts. Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "math.ts"), "utf8").catch(() => "")
      return {
        passed: /\/\*\*\s*@param/.test(txt) && /@returns/.test(txt),
        detail: txt.slice(0, 160),
      }
    },
    cleanup: clean,
  },
  {
    id: "binary-search",
    description: "Implement a binary search with tests",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "search.ts"),
        "export function binarySearch(arr: number[], target: number): number {\n  // TODO\n  return -1;\n}\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Implement binarySearch(arr, target): index or -1 in search.ts. Write it so binarySearch([1,2,3,4,5], 4) === 3. Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "search.ts"), "utf8").catch(() => "")
      return { passed: /while|if\s*\(/.test(txt) && !/TODO/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
  {
    id: "debug-inspect",
    description: "Find and remove a stray console.log",
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      await writeFile(
        join(dir, "shop.ts"),
        "console.log('DEBUG:', 'x');\nexport function total(prices: number[]): number {\n  console.log('debug total');\n  return prices.reduce((a, b) => a + b, 0);\n}\n",
        "utf8",
      )
      return dir
    },
    prompt:
      "Remove all console.log lines in shop.ts (there are 2, including inside total()). Use edit.",
    async verify(dir) {
      const txt = await readFile(join(dir, "shop.ts"), "utf8").catch(() => "")
      return { passed: !/console\.log/.test(txt), detail: txt.slice(0, 160) }
    },
    cleanup: clean,
  },
]

// Dukungan task eksternal (SWE-bench-format): array { id, description, prompt, files: {path, content}[], verify: string[] }.
export interface ExternalTask {
  id: string
  description?: string
  prompt: string
  files: { path: string; content: string }[]
  verify: string[] // substring yang harus ada di file (atau `!` untuk negatif)
}

export async function loadExternalTasks(path: string): Promise<BenchTask[]> {
  const raw = await readFile(path, "utf8")
  const list = JSON.parse(raw) as ExternalTask[]
  return list.map((t) => ({
    id: t.id,
    description: t.description ?? t.prompt.slice(0, 80),
    async setup() {
      const dir = await mkdtemp(join(tmpdir(), "minicode-bench-"))
      for (const f of t.files) {
        if (isPathOutsideRoot(f.path, dir))
          throw new Error(`external task path outside workspace: ${f.path}`)
        const abs = resolve(dir, f.path)
        if (isPathOutsideRoot(abs, dir))
          throw new Error(`external task path outside workspace: ${f.path}`)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, f.content, "utf8")
      }
      return dir
    },
    prompt: t.prompt,
    async verify(dir) {
      const results: string[] = []
      for (const v of t.verify) {
        const neg = v.startsWith("!")
        const needle = neg ? v.slice(1) : v
        let found = false
        for (const f of t.files) {
          const txt = await readFile(join(dir, f.path), "utf8").catch(() => "")
          if (txt.includes(needle)) {
            found = true
            break
          }
        }
        results.push(neg ? `!${needle}=${!found}` : `${needle}=${found}`)
        if ((!neg && !found) || (neg && found)) return { passed: false, detail: results.join(", ") }
      }
      return { passed: true, detail: results.join(", ") }
    },
    cleanup: clean,
  }))
}
