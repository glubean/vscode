# Glubean Setup

## What gets installed?

Glubean needs two things to run your API tests:

1. **Deno** — a TypeScript runtime that runs your `.test.ts` and `.explore.ts`
   files natively, with no build step or `tsconfig.json` required.
   Installed to `~/.deno/bin/` (your home directory, no sudo needed).

2. **Glubean CLI** — the test runner that powers the ▶ play buttons.
   Installed as a global Deno tool via the [JSR](https://jsr.io/@glubean/cli) registry.

## Why Deno?

Glubean runs TypeScript directly — no compilation, no `node_modules`, no
config files. Deno makes this possible. You don't need to learn Deno or
use it for anything else; it works behind the scenes as Glubean's engine.

Think of it like how VS Code ships with Electron but you never interact
with Electron directly.

## Is this safe?

- Deno is installed using the [official install script](https://docs.deno.com/runtime/getting_started/installation/)
  from `deno.land` — the same method recommended by the Deno team.
- Everything goes into your home directory (`~/.deno/`). No system files
  are modified, no `sudo` required.
- Glubean CLI is installed from [JSR](https://jsr.io/@glubean/cli), the
  JavaScript/TypeScript package registry by the Deno team. The source is
  fully open at [github.com/glubean/glubean](https://github.com/glubean/glubean).

## Can I uninstall?

```bash
# Remove Glubean CLI
deno uninstall glubean

# Remove Deno itself (optional)
rm -rf ~/.deno
```

## Already have Deno?

If Deno is already on your system, the setup will skip it and only
install the Glubean CLI. Your existing Deno version is not modified.

## Recommended: Install the Deno Extension

For the best editing experience (import completions, type checking, go-to-definition
inside SDK types), install the official **Deno extension** for VS Code:

- Search `denoland.vscode-deno` in the Extensions panel, or
  [view in Marketplace](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno).

This is optional — Glubean works without it — but strongly recommended if you
write tests frequently.

## Troubleshooting

If automatic setup fails, you can install manually:

```bash
# Step 1 — Install Deno (macOS / Linux)
curl -fsSL https://deno.land/install.sh | sh
# or: wget -qO- https://deno.land/install.sh | sh

# Step 1 — Install Deno (Windows PowerShell)
irm https://deno.land/install.ps1 | iex

# Step 2 — Install Glubean CLI (all platforms)
# Use the absolute path to avoid PATH issues after a fresh Deno install
~/.deno/bin/deno install -Agf -n glubean jsr:@glubean/cli

# Step 3 — Verify
deno --version
glubean --version
```

> **Note**: On Windows, replace `~/.deno/bin/deno` with
> `%USERPROFILE%\.deno\bin\deno.exe`.

After manual install, the extension will detect the binaries at `~/.deno/bin/`
automatically — no VS Code reload needed.

Or retry automatic setup: `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux) → **Glubean: Setup**
