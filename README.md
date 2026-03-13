<p align="center">
  <img src="icon.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean for VS Code</h1>
<p align="center">A code-first <strong>API testing</strong> system for teams — focused on durable regression suites, trace/diff observability, and CI execution from your editor.<br/>AI-friendly SDK: tell any AI assistant which API to test — or feed it your Postman collection, OpenAPI spec, or any doc that describes your endpoints — and get production-ready tests in minutes.</p>

<p align="center"><strong>API testing</strong> · <strong>regression suite</strong> · <strong>trace & diff</strong> · <strong>CI-ready</strong> · <strong>AI-friendly</strong> · <strong>OpenAPI</strong> · TypeScript</p>

<p align="center">
  <a href="https://glubean.com"><img alt="Powered by Glubean" src="https://img.shields.io/badge/Powered%20by-glubean.com-F59E0B?style=flat-square" /></a>
  <a href="https://docs.glubean.com"><img alt="Docs" src="https://img.shields.io/badge/Docs-docs.glubean.com-818cf8?style=flat-square" /></a>
</p>

## Demo

<p>
  <a href="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/demo.mp4"><img alt="▶ See extension in action" src="https://img.shields.io/badge/%E2%96%B6%20See%20extension%20in%20action-~41s-818cf8?style=for-the-badge" /></a>
  &nbsp;
  <a href="https://3ese0ujr3e86dvfp.public.blob.vercel-storage.com/demo2.mp4"><img alt="✦ Watch AI generate a test" src="https://img.shields.io/badge/%E2%9C%A6%20Watch%20AI%20generate%20a%20test-a855f7?style=for-the-badge" /></a>
  &nbsp;
  <a href="https://chatgpt.com/g/g-699e31ce19bc8191b748165f46449039-glubean"><img alt="💬 Ask AI about Glubean" src="https://img.shields.io/badge/%F0%9F%92%AC%20Ask%20AI%20about%20Glubean-ChatGPT-10a37f?style=for-the-badge" /></a>
</p>

## Quick Start

**1. Install** — from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean), [Open VSX](https://open-vsx.org/extension/Glubean/glubean), or download a [VSIX](https://github.com/glubean/vscode/releases) for Cursor / VSCodium.

**2. Try it** — create a `.test.js` file, type `gb-scratch` to insert a starter test, and click **▶**:

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

No `npm install`, no `package.json`, no setup. The response opens in the Trace Viewer right beside your code.

**3. Create a project** — when you're ready for the full experience, run `npx @glubean/cli@latest init` in your terminal to scaffold a proper project with environments, secrets, CI config, and more.

For the full walkthrough, see the [Quick Start guide](https://docs.glubean.com/extension/quick-start).

> **Scratch mode vs Project mode** — The single-file experience above is scratch mode: great for trying things out and quick API checks. It supports running tests, viewing traces, and seeing pass/fail results. For `.env` files, secrets, `test.each` / `test.pick`, CI upload, and project-level configuration, create a project with `npx @glubean/cli@latest init`.

## Features at a Glance

| Feature | Highlights |
|---|---|
| **Run tests** | Gutter ▶ buttons, editor title button, Test Explorer, `Cmd+Shift+R` re-run |
| **Traces & Diff** | Rich trace viewer, trace history with prev/next navigation, side-by-side diff |
| **Environments** | Status bar switcher for `.env` files, auto-loads matching `.secrets`, hover preview |
| **Debugging** | Full breakpoint support via Node.js inspector |
| **AI Integration** | Generate tests from OpenAPI specs |
| **Tasks Panel** | Run named test suites from the sidebar — no CLI knowledge required |
| **Data-driven** | `test.each` for every row, `test.pick` for random example selection with CodeLens |

Each feature is documented in detail at **[docs.glubean.com](https://docs.glubean.com)**.

## Documentation

- [Quick Start](https://docs.glubean.com/extension/quick-start) — install and run your first test
- [Generate Tests with AI](https://docs.glubean.com/extension/generate-with-ai) — test any public API in 2 minutes, no import files needed
- [Migrate from Postman / OpenAPI](https://docs.glubean.com/extension/migrate-from-postman) — convert existing API collections with AI
- [Running Tests](https://docs.glubean.com/extension/running-tests) — gutter buttons, Test Explorer, `test.each`, `test.pick`, Tasks Panel
- [Traces & Diff](https://docs.glubean.com/extension/traces-and-diff) — trace history, Copy as cURL, diff with previous run
- [Environments & Secrets](https://docs.glubean.com/extension/environments) — `.env` files, secrets, status bar switcher
- [Debugging](https://docs.glubean.com/extension/debugging) — breakpoints, step-through, Debug Console
- [AI Integration](https://docs.glubean.com/extension/ai-integration) — generate tests from OpenAPI specs
- [Explore vs Tests Workflow](https://docs.glubean.com/extension/workflow) — the explore → promote → CI lifecycle
- [Commands & Settings](https://docs.glubean.com/extension/reference) — full reference
- [Why Glubean?](https://docs.glubean.com/extension/comparison) — comparison with Postman and REST Client
- [Ask AI about Glubean](https://chatgpt.com/g/g-699e31ce19bc8191b748165f46449039-glubean) — not sure yet? Let AI explain how Glubean works

## How It Works

1. **Discovery** — static regex scans `*.test.{ts,js,mjs}` for `test()`, `test.each()`, `test.pick()` patterns.
2. **Display** — each test becomes a `TestItem` with ▶ buttons in the gutter and Test Explorer.
3. **Execution** — clicking ▶ runs the test via the bundled `@glubean/runner`. No external process needed.
4. **Traces** — the runner streams events; the extension writes `.trace.jsonc` to `.glubean/traces/` and opens the latest in the Trace Viewer.
5. **Results** — `.glubean/last-run.result.json` maps outcomes back to test items as ✓/✗ icons.

## Development

```bash
npm install
npm run watch    # esbuild watch mode

# Then press F5 in VS Code to launch Extension Development Host
```

### Building

```bash
npm run build:extension   # production build (extension)
npm run build:webview     # production build (webview)
npm run package           # create .vsix
```

### Project Structure

```
src/
├── extension.ts              # Entry point — setup, commands, env switcher
├── testController.ts         # Test Controller — discovery, execution, debug
├── testController/           # Focused modules: executor, artifacts, debug, results, trace
├── taskPanel/                # Tasks Panel provider, runner, parser, storage
├── webview/                  # Preact components for trace/result viewers
├── codeLensProvider.ts       # CodeLens for test.pick example buttons
├── traceCodeLensProvider.ts  # CodeLens "Trace (N)" on test definitions
├── traceViewerProvider.ts    # Custom trace viewer (CodeMirror 6)
├── resultViewerProvider.ts   # Custom result viewer
├── traceNavigator.ts         # Trace history navigation (prev/next, status bar)
├── hoverProvider.ts          # Hover preview for vars.require() / secrets.require()
├── envLoader.ts              # .env / .secrets file loader
├── parser.ts                 # Static regex parser — extracts test metadata
└── telemetry.ts              # Opt-in anonymous telemetry (PostHog)
docs/
└── telemetry.md              # Full telemetry transparency document
```

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
