import { afterAll, beforeAll } from "bun:test"
import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Isolasi tes Git dari filter system/global milik mesin operator (mis. LFS). */
export function isolateGitConfigForTests(): void {
  const globalConfig = join(tmpdir(), `minicode-test-git-${randomUUID()}`)
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM

  beforeAll(async () => {
    await writeFile(globalConfig, "", "utf8")
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_NOSYSTEM = "1"
  })

  afterAll(async () => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
    await rm(globalConfig, { force: true }).catch(() => {})
  })
}
