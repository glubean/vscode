# Pre-Launch Review — Glubean VS Code Extension

> Review conducted: 2026-02-19  
> Version reviewed: 0.2.0 (`preview: true`)  
> Reviewer: AI code review (claude-4.6-sonnet)

---

## Executive Summary

This is a well-conceived extension with solid architecture and good developer ergonomics.
The core UX — click-to-run, live output, trace history, env switcher — is polished and
largely production-ready. The main risks before launch are:

- **3 unhandled promise rejections** visible in VS Code's extension log
- **1 guaranteed double-kill bug** in the debug handler
- **1 crash-prone non-null assertion** in the setup dialog flow
- **2 keybinding conflicts** with VS Code built-in shortcuts
- Several resource leaks that accumulate with use

None of these are individually catastrophic, but they cluster around the two most
user-facing flows (setup and debug), creating a risky first impression.

---

## 1. Architecture

### Strengths

**Separation of concerns is well designed.** The layering from
`parser.ts` (pure static analysis) →
`testController.utils.ts` (pure functions, zero VS Code dependency) →
`testController.ts` (VS Code integration) →
`extension.ts` (activation + wiring) is textbook and makes the pure layers
genuinely testable without mocking VS Code.

**Provider injection** (`setPreRunCheck`, `setGlubeanPathProvider`, `setEnvFileProvider`)
cleanly decouples `extension.ts` from `testController.ts` without circular imports.

### Concerns

#### `testController.ts` at 1 672 lines is doing too much

It contains: discovery, run handler, single-test runner, file runner, run-all, debug handler,
process management, result parsing, trace auto-opening, diff, cURL copy, and the `execGlubean`
infrastructure. Suggested splits for a future refactor:

```
src/execution/run.ts        — runFile, runSingleTest, execGlubean
src/execution/debug.ts      — debugHandler, pollInspectorReady, findFreePort
src/results/reader.ts       — readResultJson, applyResults
src/results/trace.ts        — openLatestTrace (local), diffWithPrevious
src/discovery.ts            — parseFile, discoverTestsInFolder, activate
```

#### Two `openLatestTrace` functions with different signatures

`testController.ts:568` defines a local `openLatestTrace(filePath, testId?)` for
post-run auto-opening. `traceNavigator.ts` exports `openLatestTrace(workspaceRoot, fileName, testId)`
for CodeLens interaction. These are distinct functions for distinct purposes but the
naming collision will confuse future contributors — one of them should be renamed
(e.g. `openNewestTraceFile` for the local one).

#### Trace navigator state is not updated by post-run auto-open

When a test runs and auto-opens a trace, `testController.ts`'s local function does
the opening. The `traceNavigator.ts` state (`currentDir`, `currentIndex`, `traceFiles`)
is only updated when the active editor changes (`onEditorChanged`). So after a run,
the "Trace 1/5" status bar position and Alt+[ / Alt+] navigation may be momentarily
out of sync until the user focuses the trace editor. This is a minor UX inconsistency,
not a crash.

#### Module-level global state in `testController.ts`

`fileItems`, `testsRoot`, `exploreRoot`, `lastResultJsonPath`, `lastRunInclude` are
module-level singletons. This makes deactivate/reactivate not reset state cleanly
(relevant for extension development and hot-reload scenarios).

---

## 2. Bugs

### 🔴 Critical

#### 2.1 Non-null assertion crash in `showSetupDoc()` — `extension.ts:531`

```typescript
vscode.extensions.getExtension("glubean.glubean")!.extensionUri
```

`getExtension()` returns `undefined` when the extension ID doesn't match exactly
(publisher name mismatch, development installs, forks). The `!` unconditionally
asserts non-null. This will throw a runtime crash the first time a user clicks
"Learn more" or "Open Install Guide" from any setup error dialog.

**Fix:**
```typescript
const ext = vscode.extensions.getExtension("glubean.glubean");
const docUri = vscode.Uri.joinPath(
  ext?.extensionUri ?? context.extensionUri,   // context available via closure or parameter
  "docs", "setup.md"
);
```

#### 2.2 Double `killProcessGroup` in debug handler — `testController.ts:1205–1214`

```typescript
} catch (err) {
  // ...
  killProcessGroup(proc);   // ← called in catch
} finally {
  cancelDisposable.dispose();
  killProcessGroup(proc);   // ← also called in finally — always runs after catch
  run.end();
}
```

`finally` always runs after `catch`, so in the error path the process receives two SIGTERM
signals and two independent `setTimeout(...SIGKILL...)` timers are created. The second timer
is orphaned and fires against an already-dead PID, wasting resources and producing noise.

**Fix:** Remove the `killProcessGroup(proc)` from the `catch` block; keep only the `finally`.

#### 2.3 Three unhandled promise rejections at activation — `extension.ts:791, 815, 847`

```typescript
checkDependencies().then((status) => {
  // ... no .catch()
});

checkDependencies().then((depStatus) => {
  // ...
  vscode.window.showInformationMessage(...).then((choice) => {
    // ... no .catch()
  });
});
```

If `checkDependencies()` throws (e.g. filesystem permission error on Windows), VS Code logs
an unhandled rejection and some users report it as an extension crash.

Also: `checkDependencies()` is called **twice** on activation. The second call hits the cache
immediately, but the duplication is unnecessary and should be merged.

**Fix:** Combine both blocks into a single `async` IIFE with `try/catch`:
```typescript
(async () => {
  try {
    const status = await checkDependencies();
    if (!status.deno || !status.glubean) {
      setupStatusBarItem!.text = "$(warning) Glubean: Setup needed";
      // ...
    }
    if (status.deno || status.glubean) {
      await ensureDenoOnPath();
    }
    // ... init project detection
  } catch (err) {
    outputChannel.appendLine(`[activation] dependency check failed: ${err}`);
  }
})();
```

### 🟠 High

#### 2.4 `killProcessGroup` leaks a `setTimeout` on every call — `testController.ts:980`

```typescript
// Force kill after 2s grace period
setTimeout(() => {
  try { process.kill(-pid, "SIGKILL"); } catch { /* ... */ }
}, 2000);
```

The timer handle is never stored or cleared. If the process dies in under 2 seconds
(almost always in tests), the timer still fires 2 seconds later attempting `SIGKILL`
on a dead PID. Every test run leaves one dangling 2-second timer.

**Fix:**
```typescript
const forceKillTimer = setTimeout(() => { /* ... */ }, 2000);
proc.once("close", () => clearTimeout(forceKillTimer));
```

#### 2.5 `rerunLast()` CancellationTokenSource not disposed on error — `testController.ts:244`

```typescript
const cts = new vscode.CancellationTokenSource();
await runHandler(request, cts.token);  // if this throws...
cts.dispose();                          // ...this line is never reached
```

**Fix:** Wrap in `try/finally`:
```typescript
const cts = new vscode.CancellationTokenSource();
try {
  await runHandler(request, cts.token);
} finally {
  cts.dispose();
}
```

#### 2.6 `debugSessionEnded` listener leaks when safety timeout wins — `testController.ts:1165`

```typescript
const debugSessionEnded = new Promise<void>((resolve) => {
  const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.name === debugSessionName) {
      disposable.dispose();
      resolve();
    }
  });
  // disposable is never disposed if safetyTimeout or processExited wins the race
});
await Promise.race([processExited, debugSessionEnded, safetyTimeout]);
```

If the 5-minute safety timeout fires before the debug session terminates, the
`onDidTerminateDebugSession` listener is never cleaned up. It remains registered until
VS Code restarts and may match future debug sessions with the same name.

**Fix:** Store the disposable outside the Promise and dispose it after `Promise.race`:
```typescript
let debugEndedDisposable: vscode.Disposable | undefined;
const debugSessionEnded = new Promise<void>((resolve) => {
  debugEndedDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
    if (session.name === debugSessionName) {
      resolve();
    }
  });
});
try {
  await Promise.race([processExited, debugSessionEnded, safetyTimeout]);
} finally {
  debugEndedDisposable?.dispose();
}
```

### 🟡 Medium

#### 2.7 Dead code and orphaned command reference — `traceNavigator.ts:223`

```typescript
statusBarItem.command = {
  title: "Trace Navigation",
  command: "glubean.traceNavMenu",  // ← set here...
};
// Use a simpler approach: clicking the status bar cycles to the previous trace
statusBarItem.command = "glubean.tracePrev";  // ← ...immediately overwritten
```

The first assignment (lines 223–226) is dead code. `glubean.traceNavMenu` is never
registered as a command. Remove the first assignment.

#### 2.8 "Assume pass" when no result JSON in debug mode — `testController.ts:1203`

```typescript
} else {
  // No result JSON — use exit code if process already exited
  run.passed(item); // Assume pass if we got here without error
}
```

A test that produced no result JSON should not be silently passed. This masks
debugging setup failures.

**Fix:** Use `run.errored` with an explanatory message:
```typescript
run.errored(item, new vscode.TestMessage(
  "No result JSON produced. The test may not have completed — check the output for errors."
));
```

#### 2.9 `PickCodeLensProvider` event listener not tracked — `codeLensProvider.ts:43`

```typescript
// Inside constructor:
vscode.workspace.onDidSaveTextDocument(() => {
  this._onDidChangeCodeLenses.fire();
});
```

The returned disposable is not stored. In practice this is fine since the provider
lives for the extension lifetime, but if `createPickCodeLensProvider` were ever
called more than once, each call would add a permanent listener.

**Fix:** Accept `context: vscode.ExtensionContext` and push to `context.subscriptions`,
or store it on `this` and dispose in a `dispose()` method.

---

## 3. Code Quality

### Missing source maps

The build script minifies without producing source maps:

```json
"build": "esbuild ... --minify"
```

Any stack trace in production logs is completely unreadable. `dist/extension.js.map` is
handled correctly by VS Code's packaging.

**Fix:** Add `--sourcemap` to the `build` and `watch` scripts.

### No `eslint` with floating-promise rule

`npm run lint` only runs `tsc --noEmit`. None of the missing `.catch()` patterns
(bugs 2.3, 2.8) would be caught automatically.

**Fix:** Add `eslint` with `@typescript-eslint/no-floating-promises` (the most impactful
single rule for VS Code extension code). All three unhandled promise chains would be
flagged at lint time.

### Deprecated debug type `pwa-node` — `testController.ts:1129`

```typescript
type: "pwa-node",
```

`pwa-node` is a legacy alias for `node` in VS Code's `js-debug` extension. It still
works today but users may see deprecation warnings in future VS Code releases.

**Fix:** Change to `type: "node"`.

### `ensureDenoOnPath()` at 116 lines handles too many concerns

The function contains Windows registry logic, fish syntax, and zsh/bash detection
in a single cascade. It's not tested and not easy to reason about.

Consider splitting into:
- `platform/path-windows.ts`
- `platform/path-posix.ts` (handles bash, zsh, fish, `.profile`)

### `deactivate()` comment is overconfident

```typescript
export function deactivate(): void {
  // Nothing to clean up — VS Code disposes subscriptions automatically
}
```

This is true for disposables in `context.subscriptions`, but the dangling `setTimeout`
timers from `killProcessGroup` (bug 2.4) are not covered. The comment should acknowledge
this or the cleanup should be made complete.

---

## 4. User Experience

### Keybinding conflicts with VS Code built-ins

**`Cmd+Shift+T` (macOS) / `Ctrl+Shift+T` (Windows) — `package.json:183`**

This is VS Code's built-in shortcut to **reopen the last closed editor tab**. The extension
shadows it for `.test.ts`/`.explore.ts` files. Users who muscle-memory "reopen tab" while
editing a test file will instead trigger a test run. The `when` clause scopes it correctly,
but the collision is still jarring.

Recommended alternatives: `Cmd+Shift+G`, `Cmd+Option+T`, or leave it unbound and let
users configure it. Document the conflict prominently if keeping the current binding.

**`Alt+[` and `Alt+]` are unreachable on non-US keyboards**

On German, French, Spanish, and many Asian keyboard layouts, `[` and `]` require a
multi-key combo (e.g. `Alt+5` on German keyboards produces `[`). The bindings as defined
would be unreachable or produce unintended characters for a significant portion of users.

Consider using `Ctrl+Alt+[` / `Ctrl+Alt+]` (which avoid the layout issue) or making
the bindings configurable via the standard VS Code keybindings UI (they already appear
there, so users can rebind — just document this).

### "View on Web" notification fires after every run

```typescript
// testController.ts:845
if (lastResultJsonPath) {
  vscode.window.showInformationMessage("Test run complete. View results on the web?", "Open Viewer")
    .then(...);
}
```

This fires after every single run, including repeated quick runs during development.
It becomes notification spam very quickly.

**Recommendation:** Gate it on a one-time session flag
(`shownWebViewerPrompt` in `globalState`) or disable by default with a setting
`glubean.showWebViewerPrompt: boolean`.

### `glubean.runProject` appears on every folder in Explorer

```json
{
  "command": "glubean.runProject",
  "when": "explorerResourceIsFolder"
}
```

This shows "Glubean: Run All Tests in Project" on every folder including
`node_modules/`, `.git/`, `dist/`, etc. — not just workspace roots.

**Fix:** Add `&& explorerIsOpen` and consider checking for a `deno.json` presence,
or restrict to root folders only.

### Env status bar item always visible

The env switcher status bar item appears for all files once the extension is activated,
even when the user is editing a completely unrelated TypeScript file. It adds visual
noise outside test files.

**Recommendation:** Show only when the active editor is a `.test.ts` or `.explore.ts`
file, using `statusBarItem.show()` / `.hide()` in `onDidChangeActiveTextEditor`.

### Trace status bar click behaviour is asymmetric

The status bar shows `$(arrow-left) $(arrow-right)` icons suggesting bidirectional
navigation, but clicking the item calls `tracePrev` (goes older only). Users will
expect clicking the right arrow to go newer.

**Options:**
1. Show a menu (`showQuickPick`) with "← Older", "→ Newer", "Jump to..." on click.
2. Only show `$(arrow-left)` and update tooltip to say "Click for older, Alt+] for newer".

---

## 5. Developer Experience (Extension Development)

### No integration / smoke tests

The unit tests for `parser.ts` and `testController.utils.ts` are thorough and run
without VS Code. But there are no tests for:

- Extension activation (do all 14 commands register without error?)
- Command registration completeness (does `package.json` match registered commands?)
- The debug handler (identified as most error-prone in `ISSUES.md`)
- Test run → result mapping end-to-end

VS Code provides `@vscode/test-electron` for this. A minimal smoke test activating
the extension and verifying command registration would prevent regressions at almost
no maintenance cost.

### `package.json` lists `glubean.openTrace` in commands but `glubean.pickAndRun` is omitted

`glubean.pickAndRun` is registered in `extension.ts` and triggered from CodeLens but
does not appear in `contributes.commands`. This is intentional (no palette entry
needed), but it means it's invisible in the Keyboard Shortcuts editor and can't be
rebound by users who want a dedicated key for pick selection.

### No `glubean.denoPath` setting

`glubean.glubeanPath` is configurable, but Deno's path is resolved through hardcoded
logic (`~/.deno/bin` → `PATH`). In corporate environments where tools are installed
to `/opt/` or a custom directory, users have no escape hatch.

**Recommendation:** Add a `glubean.denoPath` setting parallel to `glubean.glubeanPath`.

### Trace directory not configurable

`.glubean/traces/` is hardcoded throughout. The `deno.json` docs mention a `tracesPath`
config option, but the extension does not read it.

---

## 6. Security

### Remote script execution without checksum — `extension.ts:444`

```typescript
"curl -fsSL https://deno.land/install.sh | sh"
```

This is the officially recommended Deno installation method and acceptable for a
developer tool targeting technically proficient users. The risk (MITM or compromised
`deno.land`) is the same risk users accept when following the official Deno docs.

This is **acceptable for launch** but worth noting in a SECURITY.md or the README
so users understand what the one-click setup does.

### Path input from source code in `codeLensProvider.ts:172`

```typescript
const resolvedPath = path.resolve(docDir, jsonPath);
```

`jsonPath` comes from a regex match on the test file source. The regex only matches
`.json` file extensions (`/["']([^"']+\.json)["']/`), which limits exposure, but a
path like `"../../../sensitive.json"` would be read and its keys displayed in CodeLens.
Since these are all local files the user themselves authored, this is **low risk** but
worth a note to validate the resolved path is within the workspace root.

---

## 7. Feature Gaps

### `copyAsCurl` uses fragile JSONC stripping — `testController.ts:737`

```typescript
const jsonText = text
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");
```

This breaks if a URL or header value contains `//` at the start of a line
(e.g. a `location: //cdn.example.com/path` header). Use the `jsonc-parser` package
(already a VS Code dependency via the extension host) or a proper JSONC stripper.

### No `glubean.denoPath` user setting

See §5 above.

### `glubean.initProject` is undiscoverable outside the command palette

The "No Glubean project detected" notification offers a "Quick Start" button, but
the command is not in any explorer context menu or editor title menu. Users who
dismiss the notification have no obvious way to find it again.

**Recommendation:** Add to explorer context menu when `explorerResourceIsFolder`
and the folder has no `deno.json`.

---

## 8. Summary Table

| Area | Rating | Top Issue |
|---|:---:|---|
| Architecture | ★★★★☆ | `testController.ts` too large; two trace systems out of sync |
| Correctness / Bugs | ★★★☆☆ | Non-null crash in setup dialog; double kill in debug; 3 unhandled rejections |
| Code Quality | ★★★☆☆ | No source maps; no eslint; deprecated `pwa-node` type |
| End-User UX | ★★★★☆ | Keybinding conflicts; notification spam; nav status bar asymmetry |
| Dev UX (extension dev) | ★★★☆☆ | No integration tests; no `denoPath` setting |
| Security | ★★★★☆ | Remote-script installer (industry norm); minor path concern |

---

## 9. Recommended Fix Order Before Launch

These are ordered by user-impact × likelihood of being triggered on first use.

| Priority | Issue | File | Effort |
|:---:|---|---|:---:|
| 1 | Non-null crash in `showSetupDoc()` | `extension.ts:531` | XS |
| 2 | Fix `Cmd+Shift+T` keybinding conflict (or document it) | `package.json:183` | XS |
| 3 | Add `.catch()` to 3 fire-and-forget `.then()` chains | `extension.ts:791,815,847` | S |
| 4 | Remove double `killProcessGroup` from `catch` block | `testController.ts:1209` | XS |
| 5 | Add `--sourcemap` to esbuild build script | `package.json:192` | XS |
| 6 | Fix orphaned `debugSessionEnded` listener | `testController.ts:1165` | S |
| 7 | Gate "View on Web" notification (once per session) | `testController.ts:845` | S |
| 8 | Remove dead code in `traceNavigator.ts` | `traceNavigator.ts:223` | XS |
| 9 | Fix "assume pass" when no result JSON in debug mode | `testController.ts:1203` | XS |
| 10 | Add `eslint` with `@typescript-eslint/no-floating-promises` | `package.json` | M |

Items 1–5 are essentially one-liners or two-liners and together take under an hour.
