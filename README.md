<p align="center">
  <img src="icon.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean for VS Code</h1>
<p align="center">A code-first <strong>REST client</strong> and <strong>API testing</strong> tool — the <strong>Postman alternative</strong> that lives in your editor.<br/>AI-friendly SDK: feed your <strong>OpenAPI</strong> / Swagger spec to any AI and get production-ready tests. Just TypeScript.</p>

<p align="center"><strong>REST client</strong> · <strong>API testing</strong> · <strong>Postman alternative</strong> · <strong>AI-friendly</strong> · <strong>OpenAPI</strong> · TypeScript · Deno</p>

<p align="center">
  <a href="https://glubean.com"><img alt="Powered by Glubean" src="https://img.shields.io/badge/Powered%20by-glubean.com-F59E0B?style=flat-square" /></a>
</p>

## Show me the code

```typescript
import { test } from "@glubean/sdk";

export const getProduct = test("get-product", async (ctx) => {
  const res = await ctx.http.get("https://dummyjson.com/products/1");
  ctx.expect(res).toHaveStatus(200);

  const body = await res.json();
  ctx.expect(body).toHaveProperties(["title", "brand"]);
});
```

Click the **▶** button next to `test(` to run it. The response opens as a structured trace file right beside your code.

## Why Glubean?

- **Native editor DX** — run API tests from the gutter, see results in the Test Explorer, debug with breakpoints. No browser tabs.
- **AI-friendly SDK** — rich JSDoc, `@example` tags, and explicit types mean any AI assistant can generate correct tests from a spec or a natural language prompt.
- **Trace & Diff** — every request/response is captured as a `.trace.jsonc` file. Diff against the last run instantly with VS Code's native diff.
- **Git-friendly** — your collections are `.ts` files. Review them like code, version them like code.
- **Zero config** — auto-installs the Glubean runtime on first use (~30s). Just install the extension and go.

## Quick Start

### 1. Install the extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean) or download a [VSIX](https://github.com/glubean/vscode/releases) for Cursor, VSCodium, or other forks.

On first use, the extension automatically installs two things in the background:
- **[Deno](https://deno.com)** — the awesome secure TypeScript runtime that executes your tests. Think Node.js, but with built-in TypeScript, a permission model, and no `node_modules`.
- **[Glubean CLI](https://jsr.io/@glubean/cli)** — where the magic happens. Every ▶ button click, every trace file, every diff — it's all the CLI doing the work. The extension is the UI; the CLI is the engine.

> **Tip:** Also install the [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno) to get full TypeScript type-checking and IntelliSense in your test files.

### 2. Create a project

Once the CLI is installed, scaffold a new project:

```bash
mkdir my-project && cd my-project
glubean init
```

`glubean init` creates the project structure including `deno.json` (with the `@glubean/sdk` import map), a sample `explore/` directory, and a starter test file — everything the extension needs to discover and run your tests.

You can also run **Glubean: Initialize Project** from the Command Palette (`Cmd+Shift+P`) to scaffold directly into the current workspace folder.

### 3. Run your first test

Open the generated `*.test.ts` file and click the **▶** button in the gutter next to any `test(` call. The response opens as a structured trace file right beside your code.

> For manual CLI install or troubleshooting, see the [Setup Guide](docs/setup.md).

## Features

### Run tests with one click

- **Gutter ▶ play buttons** — click next to any `test()` to run it instantly
- **Editor title ▶ button** — run all tests in the active file from the top-right corner (on `*.test.ts` files)
- **Run all in workspace** — execute every test across the workspace from the command palette
- **Test Explorer sidebar** — browse tests grouped under **Tests** (`tests/`) and **Explore** (`explore/`)
- **Re-run last** — `Cmd+Shift+R` / `Ctrl+Shift+R` to re-execute the previous request

### Instant feedback — no console.log digging

- **Rich trace viewer** — every run opens a structured `.trace.jsonc` in a custom viewer showing `{request, response}` pairs with syntax highlighting, headers, and body
- **Full HTTP detail** — method, URL, headers, body, status, and duration for every call
- **Result viewer** — `.result.json` opens in a rich viewer showing pass/fail status with assertion details
- **Copy as cURL** — convert any traced request to a cURL command in your clipboard

### Browse and compare trace history

- **Trace CodeLens** — every test shows a `Trace (N)` button with the count of saved traces; click to open the latest
- **Prev / Next** — step through older and newer traces with `Cmd+Alt+[` / `Cmd+Alt+]` (or click the status bar)
- **Status bar indicator** — shows `Trace 1/5` with your position when viewing a trace file
- **Diff with previous** — one command opens VS Code's native side-by-side diff between your two most recent runs

### Switch environments in one click

- **Status bar switcher** — toggle between `.env`, `.env.staging`, `.env.prod` from the bottom bar
- **Secrets follow automatically** — selecting `.env.staging` loads `.env.staging.secrets` for credentials
- **Hover preview** — hover over `vars.require("KEY")` or `secrets.require("KEY")` to see the resolved value (secrets are masked)

### Debug with breakpoints

Set breakpoints in your test code, step through API calls, and inspect request/response data — full VS Code debugger support via Deno's V8 inspector.

### Tasks Panel

The **Glubean Tasks** sidebar view (in the Testing section) lists tasks defined in `glubean.json`. QA engineers and team leads can run individual tasks or all tasks at once — no test file required.

### Multi-step tests

Builder-style tests (`test("id").step(...)`) show each step as a child node in the Test Explorer with individual pass/fail status. `test.each()` patterns are detected and shown as expandable groups.

## AI-Friendly by Design

Glubean's SDK is built to work with AI assistants. Every interface has rich JSDoc, `@example` tags, and explicit types — so Copilot, Cursor, ChatGPT, or any coding AI can generate correct, runnable tests with minimal prompting.

**Use natural language to explore your APIs:**

1. Paste your OpenAPI / Swagger spec (or just a few endpoint URLs) into the chat.
2. Ask your AI: _"Generate Glubean tests for the user CRUD endpoints."_
3. Drop the generated file into `explore/` and click ▶.

That's it — you go from spec to running tests in seconds, no manual HTTP client setup.

```
You → AI: "Write a Glubean test that creates a user, then fetches it and checks the name matches."

AI → explore/user-crud.test.ts (ready to run)
```

The `explore/` directory is designed for this workflow: quick iteration, no commitment. When a test proves useful, move it to `tests/` to make it permanent.

> **Tip:** Run `glubean context --openapi spec.json` to generate an AI context file (`.glubean/ai-context.md`) with SDK reference, existing test patterns, and uncovered endpoints — feed this to your AI for even better results.

## Advanced: Data-Driven Testing with `test.pick`

Run the same test logic against different example payloads. `test.pick` randomly selects one example at runtime (lightweight fuzz coverage), and CodeLens buttons let you run a specific example deterministically.

```typescript
export const createUser = test.pick({
  normal: { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
  admin: { name: "Admin", role: "admin" },
})("create-user-$_pick", async (ctx, example) => {
  await ctx.http.post("/api/users", { json: example });
});
```

Each example key gets a clickable **▶ normal**, **▶ admin**, etc. CodeLens button above the `test.pick` call.

You can also load examples from external JSON/YAML files — keeping test code focused on logic while QA or product teams contribute test cases without touching TypeScript.

```typescript
import examples from "./data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, example) => {
    await ctx.http.post("/api/users", { json: example });
  },
);
```

CLI override: `glubean run file.ts --pick admin` runs a specific example.

## File Conventions

All test files use `*.test.ts`. The **directory** determines grouping in the sidebar:

| Directory         | Purpose                                   | Test Explorer group |
| ----------------- | ----------------------------------------- | ------------------- |
| `explore/`        | Interactive API exploration (IDE workflow) | **Explore**         |
| `tests/`          | Permanent verification tests (CI / Cloud) | **Tests**           |
| Other directories | Any `*.test.ts` with SDK import           | **Tests**           |

Move a file from `explore/` to `tests/` to promote it to a permanent test — zero code changes needed.

## Commands

| Command                             | Keybinding      | Description                                             |
| ----------------------------------- | --------------- | ------------------------------------------------------- |
| Glubean: Run All Tests in File      | `Cmd+Alt+T`     | Run all tests in the active `.test.ts` file             |
| Glubean: Run All Tests in Workspace | —               | Run all tests in the workspace                          |
| Glubean: Select Environment         | —               | Open quick pick to choose `.env` file                   |
| Glubean: Re-run Last Request        | `Cmd+Shift+R`   | Re-run the most recently executed test(s)               |
| Glubean: Open Latest Trace          | —               | Open the newest trace file for the current test         |
| Glubean: Previous Trace             | `Cmd+Alt+[`     | Navigate to the older trace in history                  |
| Glubean: Next Trace                 | `Cmd+Alt+]`     | Navigate to the newer trace in history                  |
| Glubean: Diff with Previous Run     | —               | Side-by-side diff of two most recent traces             |
| Glubean: Copy as cURL               | —               | Copy HTTP requests from the open `.trace.jsonc` as cURL |
| Glubean: Clean All Traces           | —               | Delete all saved trace files                            |
| Glubean: Open Last Result JSON      | —               | Open the most recent `.result.json` in a side editor    |
| Glubean: Setup                      | —               | Install or verify Deno and Glubean CLI                  |
| Glubean: Initialize Project         | —               | Scaffold a new Glubean project in the workspace         |

## Settings

| Setting                        | Default     | Description                                                    |
| ------------------------------ | ----------- | -------------------------------------------------------------- |
| `glubean.glubeanPath`          | `"glubean"` | Path to the Glubean CLI executable                             |
| `glubean.autoDiscover`         | `true`      | Auto-discover tests when files are opened or changed           |
| `glubean.traceHistoryLimit`    | `20`        | Max trace files to keep per test (older are auto-deleted)      |
| `glubean.taskTimeoutMs`        | `300000`    | Milliseconds to wait for a task before marking it timed out    |
| `glubean.telemetry.enabled`    | `false`     | Share anonymous usage data to help improve Glubean ([details](docs/telemetry.md)) |

## How It Works

1. **Discovery** — Static regex analysis scans `*.test.ts` files for `test()`, `test.each()`, and `test.pick()` patterns. No runtime, no AST parser. Files are grouped by directory.

2. **Display** — Each test becomes a `TestItem` in VS Code's Test Controller, rendering ▶ buttons in the gutter and entries in the Test Explorer.

3. **Execution** — Clicking ▶ runs `glubean run <file> --filter <test-id> --verbose --result-json --emit-full-trace` via the CLI.

4. **Traces** — The CLI writes `.trace.jsonc` files to `.glubean/traces/`. The extension auto-opens the latest trace in the custom trace viewer.

5. **Results** — The extension reads `.result.json` and maps outcomes back to test items, showing ✓/✗ icons and populating the Test Results panel.

## All Test Patterns

```typescript
// Simple test
export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke"] },
  async (ctx) => { /* ... */ },
);

// Builder-style multi-step test
export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => { /* ... */ })
  .step("get profile", async (ctx, state) => { /* ... */ });

// Data-driven test
export const tests = test.each(data)("case-$id", async (ctx, row) => {
  /* ... */
});

// Example-driven test with random pick + CodeLens
export const createUser = test.pick({
  normal: { name: "Alice" },
  admin: { name: "Admin", role: "admin" },
})("create-user-$_pick", async (ctx, example) => { /* ... */ });
```

## Development

```bash
npm install
npm run watch    # esbuild watch mode

# Then press F5 in VS Code to launch Extension Development Host
```

### Building

```bash
npm run build      # production build
npm run package    # create .vsix
```

### Project Structure

```
src/
├── extension.ts              # Entry point — setup, commands, env switcher
├── testController.ts         # Test Controller — discovery, execution, debug
├── testController/           # Focused modules: exec, debug, results, trace
├── taskPanel/                # Tasks Panel provider, runner, parser, storage
├── webview/                  # Preact components for trace/result viewers
├── codeLensProvider.ts       # CodeLens for test.pick example buttons
├── traceCodeLensProvider.ts  # CodeLens "Trace (N)" on test definitions
├── traceViewerProvider.ts    # Custom trace viewer (CodeMirror 6)
├── resultViewerProvider.ts   # Custom result viewer
├── traceNavigator.ts         # Trace history navigation (prev/next, status bar)
├── hoverProvider.ts          # Hover preview for vars.require() / secrets.require()
├── telemetry.ts              # Opt-in anonymous telemetry (PostHog)
├── parser.ts                 # Static regex parser — extracts test metadata
└── parser.test.ts            # Parser unit tests
docs/
├── setup.md                  # Setup explainer (bundled in VSIX, opened via "Learn more")
└── telemetry.md              # Full telemetry transparency document
```

<details>
<summary>Alternative install methods</summary>

### VS Code Marketplace

Search for **Glubean** in the Extensions panel, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=Glubean.glubean).

### Manual VSIX (Cursor, VSCodium, other forks)

Download the latest `.vsix` from [GitHub Releases](https://github.com/glubean/vscode/releases), then:
`Cmd+Shift+P` (or `Ctrl+Shift+P`) → **Extensions: Install from VSIX...** → select the file.

### Manual CLI install

The extension auto-installs Deno and the CLI. If that fails, install manually:

```bash
# macOS / Linux
curl -fsSL https://glubean.com/install.sh | sh

# Or with Deno
deno install -Agf jsr:@glubean/cli
```

**Tip:** also install the [Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno) for better TypeScript intellisense.

</details>

## License

MIT

