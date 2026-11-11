// Perluasan allowlist developer (banyak bahasa/ekosistem) + zirah bash-guard
// (eval-inline interpreter baru, verba rilis-registry). Kunci agar perluasan
// tak diam-diam membuka jalur regresi.
import { expect, test } from "bun:test"
import type { ToolCall } from "#minicore"
import { createPermissionHandler } from "../src/policy/permission.ts"

function bash(cmd: string): ToolCall {
  return { name: "bash", args: { cmd } } as unknown as ToolCall
}
type Handler = ReturnType<typeof createPermissionHandler>
const dev = (): Handler => createPermissionHandler({ mode: "auto", restrictBash: true, root: "/" })
const narrow = (): Handler => createPermissionHandler({ mode: "allowlist", root: "/" })
const decide = async (h: Handler, cmd: string) => h.check(bash(cmd), {} as never)

test("dev/restrictBash: ekosistem luas diizinkan (web/mobile/backend)", async () => {
  const h = dev()
  const cmds = [
    "npm install",
    "bun install",
    "pnpm add lodash",
    "yarn install",
    "cargo build --release",
    "go test ./...",
    "rustc main.rs",
    "vite build",
    "next build",
    "esbuild app.ts",
    "pip install flask",
    "poetry install",
    "uv sync",
    "pytest -q",
    "ruff check .",
    "gem install rails",
    "bundle install",
    "rails server",
    "rspec",
    "composer install",
    "php artisan migrate",
    "phpunit",
    "mvn package",
    "gradle build",
    "./gradlew test",
    "dotnet build",
    "flutter build apk",
    "dart pub get",
    "swift build",
    "docker build -t app .",
    "docker compose up -d",
    "psql -c 'select 1'",
    "prisma migrate dev",
  ]
  for (const cmd of cmds) {
    expect({ cmd, d: await decide(h, cmd) }).toEqual({ cmd, d: "allow" })
  }
})

test("narrow (--allowlist): package manager JS lain ikut (bun/pnpm/yarn)", async () => {
  const h = narrow()
  for (const cmd of ["npm install", "bun install", "pnpm install", "yarn install"]) {
    expect({ cmd, d: await decide(h, cmd) }).toEqual({ cmd, d: "allow" })
  }
})

test("guard: verba rilis-registry ditolak (semua mode), tanpa over-block", async () => {
  const h = dev()
  const deny = [
    "npm publish",
    "cargo publish",
    "cargo login",
    "gem push",
    "dotnet nuget push",
    "poetry publish",
    "docker push",
    "docker login",
    "mvn deploy",
    "gradle publish",
    "dart pub publish",
    "twine upload",
  ]
  for (const cmd of deny) {
    expect({ cmd, d: await decide(h, cmd) }).toEqual({ cmd, d: "deny" })
  }
  // Over-block dijaga: script bernama "deploy" & subcommand biasa tetap lolos.
  for (const cmd of ["npm run deploy", "docker compose up", "mvn package", "gradle build"]) {
    expect({ cmd, d: await decide(h, cmd) }).toEqual({ cmd, d: "allow" })
  }
})

test("guard: eval-inline interpreter baru tetap ditolak", async () => {
  const h = dev()
  for (const cmd of [
    "lua -e 'os.exit()'",
    "julia -e 'run(`id`)'",
    "elixir -e 'IO.puts(1)'",
    "groovy -e 'x'",
    "scala -e 'x'",
    "node -e '1'",
  ]) {
    expect({ cmd, d: await decide(h, cmd) }).toEqual({ cmd, d: "deny" })
  }
})
