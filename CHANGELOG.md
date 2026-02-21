# Changelog

All notable changes to the Glubean VS Code extension will be documented here.

## 0.11.0 — Initial Public Release

### Features

- **Test Discovery** — Automatically discovers `*.test.ts` files that import `@glubean/sdk`; groups them under **Tests** (`tests/`) and **Explore** (`explore/`) in the Test Explorer
- **Inline Play Buttons** — Gutter ▶ buttons run individual tests or entire files; editor title ▶ button runs the whole file
- **Live Output** — Streams test execution output in real-time to the Test Results panel
- **Structured Results** — Parses `.result.json` for detailed pass/fail/skip status per test with assertions, HTTP traces, and errors
- **Custom Trace Viewer** — Opens `.trace.jsonc` files in a rich custom viewer (CodeMirror 6) showing structured `{request, response}` pairs with syntax highlighting; editor title toggle between source and rich view
- **Custom Result Viewer** — Opens `.result.json` files in a rich viewer showing test outcomes with assertion details
- **Trace History Navigation** — `Alt+[` / `Alt+]` (or `Cmd+Alt+[` / `Cmd+Alt+]`) to step through older and newer traces; status bar shows current position (`Trace 1/5`); CodeLens shows trace count above each test
- **Diff with Previous Run** — One command opens VS Code's native side-by-side diff between the two most recent traces
- **Environment Switcher** — Status bar picker to switch between `.env` files (e.g. `.env.staging`, `.env.prod`); active environment is wired into every run
- **Variable Hover Preview** — Hover over `vars.require("KEY")` or `secrets.require("KEY")` to see the resolved value from the active `.env` file (secrets are masked)
- **Copy as cURL** — Convert any traced request into a cURL command in your clipboard
- **Re-run Last Request** — `Cmd+Shift+R` / `Ctrl+Shift+R` re-executes the previous test
- **`test.pick` CodeLens** — Clickable ▶ buttons above `test.pick()` calls for each named example
- **Debug Support** — Full VS Code debugging with breakpoints via Deno's V8 inspector (`--inspect-brk`); trace file opens automatically after a debug run completes
- **One-Click Setup** — Auto-installs Deno and the Glubean CLI on first use (cross-platform: macOS, Linux, Windows); context-aware prompts for missing Deno vs missing CLI
- **Auto-Upgrade Detection** — Detects an outdated CLI at activation and prompts the user to upgrade in one click
- **Tasks Panel** — Dedicated sidebar view listing tasks defined in `glubean.json`; run individual tasks or all tasks from the panel (QA / CI workflow)
- **Project Init** — `Glubean: Initialize Project` command scaffolds a new project with `deno.json`, a sample test, and `.gitignore` entries
- **Opt-in Telemetry** — Anonymous usage statistics (run counts, feature usage, error types) via PostHog, disabled by default; prompted once after the first successful run; fully transparent — see [docs/telemetry.md](docs/telemetry.md)
