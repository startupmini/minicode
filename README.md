# MiniCode

MiniCode is an open-source terminal coding agent built on the vendored MiniCore kernel (host-editable since v0.16.0). It is zero-dependency (Bun is the only runtime). It inspects and edits a workspace, runs local tools, and connects to the AI providers and MCP/LSP servers you configure.

Interactive sessions run as a fullscreen TUI; one-shot and automation runs flow to the shell scrollback or a machine-readable JSONL stream. Every tool action is visible in the ledger, file changes are jailed to the workspace, and sensitive actions are gated behind your permission. Prompts and relevant workspace context are sent to the provider you configure; MCP and LSP servers may receive data or perform external effects. MiniCode itself sends no telemetry — traces are local-only (`MINICODE_TELEMETRY=0` to disable).

## Install

Requires Bun >=1.1.13 for development, local execution, and the published CLI:

```bash
npm install -g minicode-ai
minicode
```

To run from a clone:

```bash
git clone https://github.com/minilabs-id/minicode.git
cd minicode
bun install
bun run dev
```

## Common commands

```bash
minicode                         # interactive TUI
minicode "review this change"   # one-shot task
minicode auth login              # authenticate with a supported provider
minicode providers               # inspect configured providers
minicode exec "task" --json      # machine-readable event stream
```

WorkMode controls how the agent works (`DISCUSS`, `PLAN`, or `BUILD`); permission settings and tool access policy control which actions require approval or are available. Read [Choosing a mode](docs/choosing-mode.md) before granting write or execution access. `--sandbox docker` requests an isolated container for shell execution; the [security guide](docs/security.md) explains the remaining boundaries.

## Documentation

The full manual lives in [`docs/`](docs/) and is rendered at [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). Quick links:

- [Documentation index](docs/README.md) and [full navigation](docs/SUMMARY.md)
- [Installation](docs/getting-started.md) · [Quickstart](docs/getting-started.md) · [CLI](docs/cli.md) · [TUI](docs/repl.md)
- [Configuration and providers](docs/config.md) · [Environment variables](docs/environment.md) · [Tools](docs/tools.md)
- [Security model](docs/security.md) · [Policy and sandbox](docs/policy-sandbox.md)
- [Architecture and repository map](docs/architecture.md)
- [Contributing](docs/contributing.md) · [Release history](https://github.com/minilabs-id/minicode/releases)

## Development checks

```bash
bun x tsc --noEmit
bun run lint
bun test
bun run gate:coverage
bun run gate:pack
```

The repository's agent instructions define the required gate order and architecture constraints. Do not treat historical audit reports as current gate results; use a report only for its recorded checkpoint and scope.

## License

MIT. See [LICENSE](LICENSE).
