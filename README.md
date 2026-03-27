<p align="center">
  <img src="icon.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean for VS Code</h1>
<p align="center">Developer-owned API verification — code-first in TypeScript, accelerated by AI.<br/>Verify REST, GraphQL, gRPC, browser, and anything Node.js supports.</p>

<p align="center"><strong>verification</strong> · <strong>code-first</strong> · <strong>data-driven</strong> · <strong>result viewer</strong> · <strong>AI-native</strong> · <strong>CI-ready</strong></p>

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
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-demo-scratch.gif" alt="Glubean scratch mode demo" width="800">
</p>

## Why Glubean?

- **Not a REST client** — Write verification code that runs in CI, not click-through workflows that break.
- **Zero to running in 10 seconds** — Create a `.test.js`, click play. No setup, no config, no npm install.
- **See every detail** — [Result Viewer](https://docs.glubean.com/extension/result-viewer) shows traces, assertions, response schema, headers — all in one place.
- **AI writes your tests** — [MCP server + skill](https://docs.glubean.com/extension/generate-with-ai) + schema inference = AI understands your API and writes verification code.
- **Data-driven at scale** — [`test.each` + `test.pick`](https://docs.glubean.com/sdk/data-driven) with JSON/YAML/CSV data files, CodeLens shows every case.

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-explore.gif" alt="Glubean explore mode" width="800">
</p>

<p align="center">
  <img src="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/glubean-fix.gif" alt="Glubean fix workflow" width="800">
</p>

## Quick Start

**Prerequisites:** Node.js 20+ ([download](https://nodejs.org))

**1. Install** — from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean), [Open VSX](https://open-vsx.org/extension/Glubean/glubean), or download a [VSIX](https://github.com/glubean/vscode/releases) for Cursor / VSCodium.

**2. Try it** — create a `.test.js` file, type `gb-scratch` to insert a starter test, and click **Play**:

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

**3. Create a project** — when you're ready for the full experience, run `npx glubean init` in your terminal to scaffold a project with environments, secrets, CI config, and more.

**4. Set up AI** — if you use Claude Code, Cursor, or Codex, connect glubean's MCP server and skill:

```bash
npx glubean config mcp       # AI can discover, run, and diagnose tests
npx skills add glubean/skill  # AI learns glubean patterns to write tests
```

> **Note:** SDK reference docs are bundled with the skill — no separate download needed.

Now your AI agent can write verification tests, run them via MCP, read structured failures, and fix until green — without leaving the chat. [Learn more →](https://docs.glubean.com/extension/generate-with-ai)

> **Scratch mode vs Project mode** — The single-file experience above is scratch mode: great for trying things out and quick API checks. For `.env` files, secrets, `test.each` / `test.pick`, CI upload, and project-level configuration, create a project with `npx glubean init`. [See limitations →](https://docs.glubean.com/reference/limitations)

## Features at a Glance

| Feature | Highlights |
|---|---|
| **[Run tests](https://docs.glubean.com/extension/running-tests)** | Play buttons, Test Explorer, right-click to debug, rerun failed only |
| **[Result Viewer](https://docs.glubean.com/extension/result-viewer)** | Traces, assertions, events, response schema — navigate history with prev/next |
| **[Data-driven](https://docs.glubean.com/sdk/data-driven)** | `test.each` + `test.pick` with JSON/YAML/CSV, CodeLens per case, Open data button |
| **[Environments](https://docs.glubean.com/extension/environments)** | Status bar switcher for `.env` files, auto-loads secrets, hover preview |
| **[Diagnostics](https://docs.glubean.com/extension/diagnostics)** | `Glubean: Diagnose` — explains why something isn't working |
| **[AI Integration](https://docs.glubean.com/extension/generate-with-ai)** | MCP server + skill + lens = AI discovers, writes, runs, and fixes tests |
| **[Glubean Panel](https://docs.glubean.com/extension/running-tests#glubean-panel)** | Pin your most-used tests and files for quick access — click to open, ▶ to run |
| **Refactor Hints** | CodeLens suggests extracting inline data, promoting explore→tests |
| **Jump to Source** | Click test name in Result Viewer to jump to definition |
| **[Test Explorer Layout](https://docs.glubean.com/extension/running-tests#test-explorer-layout)** | flat/tree/auto — adapts to project size |

Each feature is documented in detail at **[docs.glubean.com](https://docs.glubean.com)**.

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
