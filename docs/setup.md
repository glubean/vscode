# Glubean Setup

If automatic setup failed, or you prefer full control over what gets installed
— this guide covers both a one-line installer and step-by-step manual setup.

Glubean needs two things to run your API tests:

1. **Deno** (2.0+) — a TypeScript runtime. Runs your `.test.ts` files natively
   with no build step. Installed to `~/.deno/bin/` (no sudo needed).

2. **Glubean CLI** — the test runner behind the ▶ play buttons.
   Installed as a Deno tool from [JSR](https://jsr.io/@glubean/cli).

---

## Option A: One-line install (recommended)

**macOS / Linux** — open a terminal and run:

```bash
curl -fsSL https://glubean.com/install.sh | sh
```

**Windows** — open PowerShell and run:

```powershell
irm https://glubean.com/install.ps1 | iex
```

This installs both Deno and the CLI, configures your PATH, and verifies
everything works. If Deno is already installed, it will be kept (or upgraded
if below 2.0).

After it finishes, reopen VS Code or open a new terminal — the extension
detects the binaries automatically.

## Option B: Manual install

Use this if the one-liner fails (network restrictions, corporate proxy, etc.)
or if you prefer to install things yourself.

### macOS / Linux

```bash
# 1. Install Deno
curl -fsSL https://deno.land/install.sh | sh

# 2. Install Glubean CLI (use absolute path to avoid PATH issues)
~/.deno/bin/deno install -Agf -n glubean jsr:@glubean/cli

# 3. Add to PATH (if not already there)
echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 4. Verify
deno --version     # should be 2.0+
glubean --version
```

### Windows (PowerShell)

```powershell
# 1. Install Deno
irm https://deno.land/install.ps1 | iex

# 2. Install Glubean CLI
$env:USERPROFILE\.deno\bin\deno.exe install -Agf -n glubean jsr:@glubean/cli

# 3. Verify
deno --version
glubean --version
```

After manual install, the extension detects binaries at `~/.deno/bin/`
automatically — no VS Code reload needed.

---

## Install the Deno extension

For the best editing experience, also install the **Deno extension** for VS Code:

> Search **denoland.vscode-deno** in the Extensions panel, or
> [install from Marketplace](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno).

This gives you import completions, type checking, and go-to-definition inside
Glubean SDK types. It's optional — Glubean works without it — but strongly
recommended.

---

## Why Deno?

Glubean runs TypeScript directly — no compilation, no `node_modules`, no config
files. Deno makes this possible. You don't need to learn Deno or use it for
anything else; it works behind the scenes as Glubean's engine.

Think of it like how VS Code ships with Electron but you never interact with
Electron directly.

## Is this safe?

- Deno is installed from `deno.land` using the
  [official install script](https://docs.deno.com/runtime/getting_started/installation/).
- Everything goes into `~/.deno/`. No system files are modified.
- Glubean CLI source is fully open at
  [github.com/glubean/glubean](https://github.com/glubean/glubean).

## Uninstall

**macOS / Linux:**

```bash
deno uninstall glubean       # Remove CLI
rm -rf ~/.deno               # Remove Deno (optional)
```

**Windows (PowerShell):**

```powershell
deno uninstall glubean                            # Remove CLI
Remove-Item -Recurse -Force "$env:USERPROFILE\.deno"  # Remove Deno (optional)
```

## Still stuck?

Retry automatic setup from VS Code: `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P`
(Windows/Linux) → **Glubean: Setup**

Or ask in [GitHub Discussions](https://github.com/glubean/vscode/discussions).
