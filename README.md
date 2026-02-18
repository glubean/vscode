<p align="center">
  <img src="icon.png" width="120" alt="Glubean" />
</p>

<h1 align="center">Glubean for VS Code</h1>
<p align="center"><strong>API collections, as real code.</strong> No context switching, no proprietary GUI, just TypeScript.</p>

<!-- TODO: replace with actual GIF showing gutter click → green check → trace opens beside -->
<!-- ![Glubean in action](docs/demo.gif) -->

## Show me the code

```typescript
import { test, expect } from "@glubean/sdk";

export const getUser = test("get-user", async (ctx) => {
  const res = await ctx.http.get("https://api.example.com/user/1");

  expect(res.status).toBe(200);
  expect(res.json()).toHaveProperty("role", "admin");
});
```

Click the **▶** button next to `test(` to run it. The response opens as a structured trace file right beside your code.

## Why Glubean?

- **Native editor DX** — run API tests from the gutter, see results in the Test Explorer, debug with breakpoints. No browser tabs.
- **Trace & Diff** — every request/response is captured as a `.trace.jsonc` file. Diff against the last run instantly with VS Code's native diff.
- **Git-friendly** — your collections are `.ts` files. Review them like code, version them like code.
- **Zero config** — auto-installs the Glubean runtime on first use (~30s). Just install the extension and go.

## Quick Start

1. Install the extension ([Marketplace](https://marketplace.visualstudio.com/items?itemName=glubean.glubean) or [VSIX download](https://github.com/glubean/vscode/releases)).
2. Open any `*.test.ts` file that imports `@glubean/sdk`.
3. Click the **▶** button in the gutter.

> The extension auto-installs Deno and the Glubean CLI on the first run. No manual setup required.
> For manual install or troubleshooting, see the [Setup Guide](docs/setup.md).

## Features

### Run tests with one click

- **Gutter ▶ play buttons** — click next to any `test()` to run it instantly
- **Editor title ▶ button** — run all tests in the active file from the top-right corner (on `*.test.ts` files)
- **Run all in workspace** — execute every test across the workspace from the command palette
- **Test Explorer sidebar** — browse tests grouped under **Tests** (`tests/`) and **Explore** (`explore/`)
- **Re-run last** — `Cmd+Shift+R` / `Ctrl+Shift+R` to re-execute the previous request

### Instant feedback — no console.log digging

- **Auto-open trace files** — every run produces a structured `.trace.jsonc` with `{request, response}` pairs, opened side-by-side automatically
- **Full HTTP detail** — method, URL, headers, body, status, and duration for every call
- **Copy as cURL** — convert any traced request to a cURL command in your clipboard

### Browse and compare trace history

- **Trace CodeLens** — every test shows a `Trace (N)` button with the count of saved traces; click to open the latest
- **Prev / Next** — step through older and newer traces with `Alt+[` / `Alt+]` (or click the status bar)
- **Status bar indicator** — shows `Trace 1/5` with your position when viewing a trace file
- **Diff with previous** — one command opens VS Code's native side-by-side diff between your two most recent runs

<!-- TODO: screenshot of diff view -->

### Switch environments in one click

- **Status bar switcher** — toggle between `.env`, `.env.staging`, `.env.prod` from the bottom bar
- **Secrets follow automatically** — selecting `.env.staging` loads `.env.staging.secrets` for credentials
- **Hover preview** — hover over `vars.require("KEY")` or `secrets.require("KEY")` to see the resolved value (secrets are masked)

### Debug with breakpoints

Set breakpoints in your test code, step through API calls, and inspect request/response data — full VS Code debugger support via Deno's V8 inspector.

### Multi-step tests

Builder-style tests (`test("id").step(...)`) show each step as a child node in the Test Explorer with individual pass/fail status. `test.each()` patterns are detected and shown as expandable groups.

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

Each example key gets a clickable **▶ normal**, **▶ admin**, etc. above the `test.pick` call.

![CodeLens buttons for test.pick examples](docs/codelens-pick.png)

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

| Command                             | Keybinding    | Description                                             |
| ----------------------------------- | ------------- | ------------------------------------------------------- |
| Glubean: Run All Tests in File      | —             | Run all tests in the active `.test.ts` file             |
| Glubean: Run All Tests in Workspace | —             | Run all tests in the workspace                          |
| Glubean: Select Environment         | —             | Open quick pick to choose `.env` file                   |
| Glubean: Re-run Last Request        | `Cmd+Shift+R` | Re-run the most recently executed test(s)               |
| Glubean: Open Latest Trace          | —             | Open the newest trace file for the current test         |
| Glubean: Previous Trace             | `Alt+[`       | Navigate to the older trace in history                  |
| Glubean: Next Trace                 | `Alt+]`       | Navigate to the newer trace in history                  |
| Glubean: Diff with Previous Run     | —             | Side-by-side diff of two most recent traces             |
| Glubean: Copy as cURL               | —             | Copy HTTP requests from the open `.trace.jsonc` as cURL |
| Glubean: Clean All Traces           | —             | Delete all saved trace files                            |
| Glubean: Open Last Result JSON      | —             | Open the most recent `.result.json` in a side editor    |
| Glubean: Setup                      | —             | Install or verify Deno and Glubean CLI                  |

## Settings

| Setting                      | Default     | Description                                              |
| ---------------------------- | ----------- | -------------------------------------------------------- |
| `glubean.glubeanPath`        | `"glubean"` | Path to the Glubean CLI executable                       |
| `glubean.autoDiscover`       | `true`      | Auto-discover tests when files are opened or changed     |
| `glubean.traceHistoryLimit`  | `20`        | Max trace files to keep per test (older are auto-deleted) |

Environment file and verbose mode are controlled via the status bar picker and always-on respectively.

## How It Works

1. **Discovery** — Static regex analysis scans `*.test.ts` files for `test()`, `test.each()`, and `test.pick()` patterns. No runtime, no AST parser. Files are grouped by directory.

2. **Display** — Each test becomes a `TestItem` in VS Code's Test Controller, rendering ▶ buttons in the gutter and entries in the Test Explorer.

3. **Execution** — Clicking ▶ runs `glubean run <file> --filter <test-id> --verbose --result-json --emit-full-trace` via the CLI.

4. **Traces** — The CLI writes `.trace.jsonc` files to `.glubean/traces/`. The extension auto-opens the latest trace in a side editor.

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
├── testController.utils.ts   # Result parsing, output formatting helpers
├── codeLensProvider.ts       # CodeLens for test.pick example buttons
├── traceCodeLensProvider.ts  # CodeLens "Trace (N)" on test definitions
├── traceNavigator.ts         # Trace history navigation (prev/next, status bar)
├── hoverProvider.ts          # Hover preview for vars.require() / secrets.require()
├── parser.ts                 # Static regex parser — extracts test metadata
├── parser.test.ts            # Parser unit tests
└── testController.utils.test.ts  # Utils unit tests
docs/
└── setup.md                  # Setup explainer (bundled in VSIX, opened via "Learn more")
```

<details>
<summary>Alternative install methods</summary>

### VS Code Marketplace

Search for **Glubean** in the Extensions panel, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=glubean.glubean).

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
