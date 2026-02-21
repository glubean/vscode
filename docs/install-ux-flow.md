# Installation UX Flow

This document describes the user-facing installation experience designed into the
Glubean VS Code extension. It's meant as a reference for reviewing the code in
`extension.ts` — so you know *what the user sees* at each stage without having to
mentally trace every code path.

## Design Principles

1. **Non-intrusive first, blocking only when necessary** — no popup on activation;
   the user is gently nudged via the status bar. The real prompt only appears when
   they actually try to *do something* (run a test).
2. **One-click, zero-config** — the user never needs to open a terminal, run shell
   commands, or edit config files. Everything is handled behind a single "Continue"
   button.
3. **No window reload** — after installation, the extension uses absolute paths
   (`~/.deno/bin/deno`, `~/.deno/bin/glubean`) internally. The user does **not**
   need to reload VS Code.
4. **Graceful failure with escape hatches** — if auto-install fails, the user is
   offered "Open Install Guide" (renders `docs/setup.md` in-editor) and "Retry".

---

## Stage 1: Activation — Status Bar Hint

**When**: Extension activates (VS Code opens a workspace with `.test.ts` files).

**What happens in code**: `checkDependencies()` runs silently. If Deno or CLI
is missing:

```
┌──────────────────────────────────────────────────────┐
│  Status bar (bottom-right):                          │
│  [⚠ Glubean: Setup needed]  ← red background        │
│                                                      │
│  Clicking it → triggers `glubean.checkDependencies`  │
│             → which calls `runSetup()`               │
└──────────────────────────────────────────────────────┘
```

**If deps are already installed**: Nothing is shown. The extension silently calls
`ensureDenoOnPath()` to make sure `~/.deno/bin` is in the user's shell rc file
(idempotent — checks before writing).

**Key code**: `extension.ts` lines ~630–660.

---

## Stage 2: Play Button Press — Blocking Prompt

**When**: User clicks a ▶ play button (gutter or Test Explorer) but deps are missing.

**What happens in code**: `testController` calls `preRunCheck()` →
`promptInstallIfNeeded()`. Test execution is **blocked** until the user responds.

The message is tailored to what's actually missing:

| Missing | Message |
|:--------|:--------|
| Both Deno + CLI | "Glubean needs a one-time setup to run TypeScript natively (~30s)." |
| Deno only | "Glubean needs to install a TypeScript runtime (Deno) to run your tests." |
| CLI only | "Glubean CLI is not installed. Set it up to enable play buttons and test running." |

```
┌─────────────────────────────────────────────────────────────────┐
│  ℹ Glubean needs a one-time setup to run TypeScript             │
│    natively (~30s).                                             │
│                                                                 │
│    [ Continue ]    [ Learn more ]                               │
└─────────────────────────────────────────────────────────────────┘
```

- **"Continue"** → goes to Stage 3 (install).
- **"Learn more"** → opens `docs/setup.md` as a Markdown preview inside VS Code,
  then shows a follow-up "Ready to install?" → "Continue" / "Not now".
- **Dismissed (click away)** → nothing happens; prompt re-appears next time the
  user tries to run a test.

**Anti-spam**: A `setupInProgress` flag prevents multiple prompts from stacking
if the user clicks several play buttons quickly.

**Key code**: `extension.ts` `promptInstallIfNeeded()` (~line 436).

---

## Stage 3: Installation — Progress Notification

**When**: User clicks "Continue" from either the status bar or the blocking prompt.

**What the user sees**: A non-dismissable progress notification in the bottom-right:

```
Setting up Glubean
├─ "Installing Deno runtime..."        ← Step 1 (skipped if Deno exists)
├─ "Installing Glubean CLI..."         ← Step 2 (skipped if CLI exists)
├─ "Configuring PATH..."               ← Step 3 (always runs, idempotent)
├─ "Verifying installation..."         ← Step 4
└─ "Ready!"                            ← Brief pause, then success message
```

**Under the hood** (`runSetup()`):

1. **Install Deno** (if missing):
   - macOS/Linux: `curl -fsSL https://deno.land/install.sh | sh` (fallback: `wget`)
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://deno.land/install.ps1 | iex"`
   - Verifies with `~/.deno/bin/deno --version`

2. **Install Glubean CLI** (if missing):
   - `deno install -Agf -n glubean jsr:@glubean/cli`

3. **Configure PATH**:
   - Appends `export PATH="$HOME/.deno/bin:$PATH"` to the user's shell rc file
   - Checks `.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile`, `.profile` for
     existing entries to avoid duplicates
   - Fish shell gets `fish_add_path` syntax
   - Windows updates User-level PATH via PowerShell

4. **Verify**:
   - Clears the cached dep status
   - Runs `checkDependencies()` again
   - If verified → success message + hides status bar hint

**Key code**: `extension.ts` `runSetup()` (~line 305).

---

## Stage 4: Success

```
┌─────────────────────────────────────────────────────────────────┐
│  ✓ Glubean is ready — run tests with the ▶ play button.        │
│    Open a new terminal for `glubean` CLI access.               │
└─────────────────────────────────────────────────────────────────┘
```

- Status bar `⚠ Setup needed` is hidden.
- Play buttons work immediately — no reload needed.
- The "open a new terminal" note is because existing terminal sessions won't
  pick up the PATH change until restarted.

---

## Error Paths

### Install failed (network, permissions, etc.)

```
┌─────────────────────────────────────────────────────────────────┐
│  ✕ Glubean setup failed: <error message>                        │
│                                                                 │
│    [ Open Install Guide ]    [ Retry ]                          │
└─────────────────────────────────────────────────────────────────┘
```

- **"Open Install Guide"** → shows `docs/setup.md` in Markdown preview
- **"Retry"** → clears cache, runs `runSetup()` again

### Deno installed but binary not found

```
┌─────────────────────────────────────────────────────────────────┐
│  ✕ Deno installation succeeded but the binary was not found.    │
│    You may need to restart VS Code so your PATH is updated.     │
└─────────────────────────────────────────────────────────────────┘
```

### Install succeeded but verification failed

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠ Glubean was installed but could not be verified.             │
│    Try reloading VS Code (Cmd+Shift+P → Reload Window).        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Manual Fallback: `Glubean: Setup` Command

Available anytime via Command Palette (`Cmd+Shift+P` → "Glubean: Setup").
This is wired to `glubean.checkDependencies`:

- If deps are installed → shows "All dependencies are installed." + ensures PATH.
- If deps are missing → runs `runSetup()`.

---

## Flowchart

```
Extension activates
       │
       ▼
 checkDependencies()
       │
       ├── All installed ──► ensureDenoOnPath() (silent, idempotent)
       │                     Done. No UI shown.
       │
       └── Something missing ──► Show status bar: [⚠ Glubean: Setup needed]
                                        │
                    ┌───────────────────┤
                    │                    │
              User clicks          User clicks ▶
              status bar           play button
                    │                    │
                    ▼                    ▼
            runSetup()         promptInstallIfNeeded()
                                        │
                                ┌───────┼────────┐
                                │       │        │
                          "Continue" "Learn    Dismissed
                                │    more"       │
                                │       │     (no-op,
                                │       ▼    re-prompts
                                │   setup.md   next time)
                                │   preview
                                │       │
                                │   "Continue"
                                │       │
                                ▼       ▼
                             runSetup()
                                │
                    ┌───────────┼───────────┐
                    │           │           │
                 Success     Failure    Verify
                    │           │        failed
                    ▼           ▼           ▼
               "Ready!"    "Open Guide"  "Reload
               Hide bar    or "Retry"    Window"
```

---

## Code Map

| Function | File | Purpose |
|:---------|:-----|:--------|
| `checkDependencies()` | `extension.ts` | Detect Deno + CLI (fast path: `fs.existsSync`, fallback: `spawn --version`) |
| `runSetup()` | `extension.ts` | One-click install with progress notification |
| `promptInstallIfNeeded()` | `extension.ts` | Blocking prompt shown before test execution |
| `showSetupDoc()` | `extension.ts` | Render `docs/setup.md` in Markdown preview |
| `ensureDenoOnPath()` | `extension.ts` | Append `~/.deno/bin` to shell rc files (idempotent) |
| `resolveGlubeanPath()` | `extension.ts` | Resolve CLI binary path for execution (settings → `~/.deno/bin` → PATH) |
| `setPreRunCheck()` | `testController.ts` | Hook that wires `promptInstallIfNeeded` into the test runner |
