<p align="center">
  <img src="icon.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean — REST Client & API Test Runner</h1>
<p align="center">Explore APIs, run tests, and debug with breakpoints — code-first in TypeScript.<br/>Works with REST, GraphQL, gRPC, browser, and anything Node.js supports.</p>

<p align="center"><strong>explore</strong> · <strong>test</strong> · <strong>debug</strong> · <strong>traces</strong> · <strong>AI-native</strong> · <strong>CI-ready</strong></p>

<p align="center">
  <a href="https://glubean.com"><img alt="Powered by Glubean" src="https://img.shields.io/badge/Powered%20by-glubean.com-F59E0B?style=flat-square" /></a>
  <a href="https://docs.glubean.com"><img alt="Docs" src="https://img.shields.io/badge/Docs-docs.glubean.com-818cf8?style=flat-square" /></a>
</p>

<p align="center">💬 <a href="https://chatgpt.com/g/g-699e31ce19bc8191b748165f46449039-glubean">Ask Glubean AI anything</a> — setup help, feature questions, comparisons</p>

## Demo

<p>
  <a href="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/demo.mp4"><img alt="See extension in action" src="https://img.shields.io/badge/%E2%96%B6%20See%20extension%20in%20action-~41s-818cf8?style=for-the-badge" /></a>
  &nbsp;
  <a href="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/demo2.mp4"><img alt="Watch AI generate a test" src="https://img.shields.io/badge/%E2%9C%A6%20Watch%20AI%20generate%20a%20test-a855f7?style=for-the-badge" /></a>
</p>

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-explore.gif" alt="Explore APIs with Glubean" width="800">
</p>

## Quick Start

**Prerequisites:** Node.js 20+ ([download](https://nodejs.org))

**1. Install** — from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean), [Open VSX](https://open-vsx.org/extension/Glubean/glubean), or download a [VSIX](https://github.com/glubean/vscode/releases) for Cursor / VSCodium.

**2. Explore an API** — create an `explore/hello.test.js` file, type `gb-scratch`, and click **Play**:

```javascript
import { test } from "@glubean/sdk";

export const getProducts = test("get-products", async (ctx) => {
  const res = await ctx.http.get("https://dummyjson.com/products");
  ctx.expect(res).toHaveStatus(200);

  const data = await res.json();
  ctx.expect(data).toHaveProperty("products");
  ctx.log("total", data.total);
});
```

No `npm install`, no `package.json`, no setup. The response opens in the Result Viewer right beside your code.

**3. Create a project** — when you're ready, run `npx glubean init` to scaffold a project with environments, secrets, CI config, and more.

**4. Set up AI** — if you use Claude Code, Cursor, or Codex, connect Glubean's MCP server and skill:

```bash
npx glubean config mcp       # AI can discover, run, and diagnose tests
npx skills add glubean/skill  # AI learns glubean patterns to write tests
```

> SDK reference docs are bundled with the skill — no separate download needed.

Now your AI agent can write tests, run them via MCP, read structured failures, and fix until green — without leaving the chat. [Learn more →](https://docs.glubean.com/extension/generate-with-ai)

## Explore: Postman Alternative in Your Editor

`explore/` is where exploratory API work replaces Postman — without fragmenting your stack or trapping drafts in a second tool.

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-demo-scratch.gif" alt="Glubean scratch mode" width="800">
</p>

A workflow starts in `explore/` as a quick API check, then graduates into a committed test without changing tools:

- **Scratch mode** — single-file, zero config, click play and see the response
- **Promote to test** — move the same file to your test directory, add assertions, commit
- **Same file in CI** — the same TypeScript file runs locally, in CI, and in Cloud

> **Scratch mode vs Project mode** — The single-file experience is great for trying things out. For `.env` files, secrets, `test.each` / `test.pick`, CI upload, and project-level config, create a project with `npx glubean init`. [See limitations →](https://docs.glubean.com/reference/limitations)

## Why Glubean?

**Code-first, not click-through.** Write TypeScript that runs in CI — not click-through workflows that break when someone renames a field.

**Agents write, Glubean keeps them alive.** AI generates the test, structured failures tell the agent what broke, the agent fixes and reruns — a self-repairing loop. [Learn more →](https://docs.glubean.com/extension/generate-with-ai)

**See every detail.** The [Result Viewer](https://docs.glubean.com/extension/result-viewer) shows request/response traces, assertions, events, response schema, and run history — all inline. Compare two runs with trace diff.

**Data-driven at scale.** [`test.each` + `test.pick`](https://docs.glubean.com/sdk/data-driven) with JSON/YAML/CSV data files, CodeLens shows every case.

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-fix.gif" alt="Glubean fix workflow" width="800">
</p>

## Features

| Feature | Highlights |
|---|---|
| **[Explore APIs](https://docs.glubean.com/extension/quick-start)** | Scratch mode, zero config, explore/ as Postman replacement |
| **[Run tests](https://docs.glubean.com/extension/running-tests)** | Play buttons, Test Explorer, right-click to debug, rerun failed only |
| **[Result Viewer](https://docs.glubean.com/extension/result-viewer)** | Traces, assertions, events, response schema — navigate history with prev/next |
| **[Trace diff](https://docs.glubean.com/extension/result-viewer)** | Compare two runs with native diff to see what changed |
| **[Data-driven](https://docs.glubean.com/sdk/data-driven)** | `test.each` + `test.pick` with JSON/YAML/CSV, CodeLens per case |
| **[Environments](https://docs.glubean.com/extension/environments)** | Status bar switcher for `.env` files, auto-loads secrets, hover preview |
| **[Debugging](https://docs.glubean.com/extension/debugging)** | Breakpoints, step-through, Debug Console — real TypeScript |
| **[AI Integration](https://docs.glubean.com/extension/generate-with-ai)** | MCP server + skill = AI discovers, writes, runs, and fixes tests |
| **[Diagnostics](https://docs.glubean.com/extension/diagnostics)** | `Glubean: Diagnose` — explains why something isn't working |
| **[Glubean Panel](https://docs.glubean.com/extension/running-tests#glubean-panel)** | Pin tests and files for quick access — click to open, run |
| **Refactor Hints** | CodeLens suggests extracting inline data, promoting explore→tests |
| **[Test Explorer Layout](https://docs.glubean.com/extension/running-tests#test-explorer-layout)** | flat/tree/auto — adapts to project size |

## Documentation

- [Quick Start](https://docs.glubean.com/extension/quick-start) — install and run your first test
- [Writing Tests](https://docs.glubean.com/extension/writing-tests) — CodeLens, snippets, data-driven patterns
- [Running Tests](https://docs.glubean.com/extension/running-tests) — play buttons, Test Explorer, Glubean Panel, rerun failed
- [Result Viewer](https://docs.glubean.com/extension/result-viewer) — traces, assertions, history, jump to source
- [Environments & Secrets](https://docs.glubean.com/extension/environments) — `.env` files, secrets, status bar switcher
- [AI Integration](https://docs.glubean.com/extension/generate-with-ai) — MCP server, skill, AI authoring loop
- [Debugging](https://docs.glubean.com/extension/debugging) — breakpoints, step-through, Debug Console
- [Diagnostics](https://docs.glubean.com/extension/diagnostics) — troubleshooting, common problems
- [Commands & Settings](https://docs.glubean.com/extension/reference) — full reference
- [Limitations](https://docs.glubean.com/reference/limitations) — trade-offs and known limitations

## How It Works

1. **Discovery** — static regex scans `*.test.{ts,js,mjs}` for `test()`, `test.each()`, `test.pick()` patterns.
2. **Display** — each test becomes a `TestItem` with play buttons in the gutter and Test Explorer.
3. **Execution** — clicking play runs the test via the bundled `@glubean/runner`. No external process needed.
4. **Results** — the runner streams events; the extension writes `.result.json` to `.glubean/results/` and opens in the Result Viewer.
5. **History** — prev/next navigation across runs, rerun failed tests with one click.

<details>
<summary>Alternative install methods</summary>

### VS Code Marketplace

Search for **Glubean** in the Extensions panel, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean).

### Open VSX (VSCodium, Gitpod, etc.)

Search for **Glubean** in [Open VSX](https://open-vsx.org/extension/Glubean/glubean).

### Manual VSIX (Cursor, Windsurf, other forks)

Download the `.vsix` for your platform from [GitHub Releases](https://github.com/glubean/vscode/releases), then:
`Cmd+Shift+P` (or `Ctrl+Shift+P`) → **Extensions: Install from VSIX...** → select the file.

</details>

## License

MIT
