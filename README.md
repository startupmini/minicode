# MiniCode

MiniCode is a terminal coding agent built on the vendored MiniCore runtime. It can inspect and edit a workspace, run local tools, and connect to configured AI providers and external MCP/LSP servers.

Interactive sessions use a fullscreen TUI. One-shot and automation runs use the shell scrollback or a machine-readable stream. Prompts and relevant workspace context are sent to the provider you configure; MCP and LSP servers may receive data or perform external effects.

## Install

Requires Bun `>=1.1.13` for development and local execution. For the published CLI:

```bash
npm install -g minicode-ai
minicode
```

To run from a clone:

```bash
git clone https://github.com/startupmini/minicode.git
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

- [Documentation index](docs/README.md) and [full navigation](docs/SUMMARY.md)
- [Installation](docs/getting-started.md) · [Quickstart](docs/quickstart.md) · [CLI](docs/cli.md) · [TUI](docs/repl.md)
- [Configuration and providers](docs/config.md) · [Environment variables](docs/environment.md) · [Tools](docs/tools.md)
- [Security model](docs/security-model.md) · [Policy and sandbox](docs/policy-sandbox.md)
- [Architecture and repository map](docs/architecture.md)
- [Contributing](docs/contributing.md) · [Release history](https://github.com/startupmini/minicode/releases)

## Development checks

```bash
bun x tsc --noEmit
bun run lint
bun test
bun run gate:coverage
bun run gate:pack
```

The repository [agent instructions](AGENTS.md) define the required gate order and architecture constraints. Do not treat historical audit reports as current gate results; use a report only for its recorded checkpoint and scope.

## License

MIT. See [LICENSE](LICENSE).
