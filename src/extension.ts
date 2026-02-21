/**
 * Glubean VS Code Extension — main entry point.
 *
 * Activates the Test Controller for ▶ play buttons, Test Explorer sidebar,
 * and pass/fail status display in the gutter.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as testController from "./testController";
import { createHoverProvider } from "./hoverProvider";
import { createPickCodeLensProvider } from "./codeLensProvider";
import { createTraceCodeLensProvider } from "./traceCodeLensProvider";
import { activateTraceNavigator } from "./traceNavigator";

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe interpolation inside a shell command.
 *
 * On Unix, wraps in single quotes (the only char that needs escaping inside
 * single quotes is the single quote itself: ' → '\''). On Windows (cmd.exe),
 * wraps in double quotes and escapes internal double-quotes with backslash.
 *
 * Used only for `terminal.sendText()` — the one place we intentionally target
 * the user's interactive shell. All extension-host execution uses non-shell
 * `cp.spawn()`/`cp.execFile()` with args arrays instead.
 */
function shellQuote(arg: string): string {
  if (process.platform === "win32") {
    // cmd.exe / PowerShell: wrap in double quotes, escape inner double-quotes
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  // POSIX: wrap in single quotes; replace inner ' with '\''
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * Pick the workspace folder most relevant to the current context.
 *
 * Resolution order:
 * 1. Active editor's workspace folder
 * 2. Single-root workspace → that folder
 * 3. Multi-root workspace → prompt the user to pick one
 */
async function pickWorkspaceFolder(): Promise<
  vscode.WorkspaceFolder | undefined
> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];

  return vscode.window.showWorkspaceFolderPick({
    placeHolder: "Select workspace folder for Glubean",
  });
}

// ---------------------------------------------------------------------------
// Dependency detection & one-click setup
// ---------------------------------------------------------------------------

/** Minimum Deno version required (major.minor). Aligns with install.sh. */
const DENO_MIN_MAJOR = 2;
const DENO_MIN_MINOR = 0;

/**
 * Minimum Glubean CLI version the extension requires.
 * Bump this when the extension depends on new CLI/runner features.
 */
const MIN_CLI_VERSION = "0.11.6";

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

/** Parse "major.minor.patch" into a triple, or null on invalid input. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** True when `installed` is older than `required` (both semver strings). */
function semverLessThan(installed: string, required: string): boolean {
  const a = parseSemver(installed);
  const b = parseSemver(required);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

interface DepStatus {
  deno: boolean;
  glubean: boolean;
  /** True when Deno exists but is below the minimum required version. */
  denoTooOld?: boolean;
  /** Installed CLI version string, e.g. "0.11.2". Empty if CLI not found. */
  cliVersion?: string;
  /** True when CLI exists but is below MIN_CLI_VERSION. */
  cliOutdated?: boolean;
}

/** Cache so we only check once per session (cleared by "Setup" action). */
let cachedDepStatus: DepStatus | undefined;

/** Prevent multiple setup prompts from stacking. */
let setupInProgress = false;

/** Status bar item shown when setup is needed (non-intrusive alternative to popup). */
let setupStatusBarItem: vscode.StatusBarItem | undefined;

/** Fallback URI for this extension (used when extension lookup by ID fails). */
let selfExtensionUri: vscode.Uri | undefined;

/**
 * Check whether a command is available on the system PATH.
 * Returns true if the command exits with code 0.
 */
function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = cp.spawn(command, ["--version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Get the version string from a command's `--version` output.
 * Returns the version (e.g. "2.6.9") or empty string on failure.
 */
function getCommandVersion(command: string): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(command, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      // deno --version output: "deno 2.6.9 (stable, ...)"
      const match = stdout.match(/deno\s+(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : "");
    });
  });
}

/**
 * Get the installed Glubean CLI version.
 * Parses ANSI-colored output like "\x1b[1mglubean\x1b[22m \x1b[94m0.11.2\x1b[39m".
 */
function getCliVersion(cliPath: string): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(cliPath, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      // Strip ANSI escape codes then match "glubean X.Y.Z"
      const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
      const match = plain.match(/glubean\s+(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : "");
    });
  });
}

/**
 * Check if a version string meets the minimum Deno requirement.
 */
function denoVersionOk(version: string): boolean {
  const parts = version.split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (isNaN(major) || isNaN(minor)) return false;
  if (major > DENO_MIN_MAJOR) return true;
  if (major === DENO_MIN_MAJOR && minor >= DENO_MIN_MINOR) return true;
  return false;
}

/**
 * Detect whether Deno and Glubean CLI are installed.
 *
 * Uses a two-tier strategy:
 * 1. Fast path: check if the binary files exist at well-known locations
 *    (~/.deno/bin/). This is instant and avoids the slow first-run package
 *    download that `glubean --version` triggers via JSR.
 * 2. Fallback: try spawning the command on PATH (for non-standard installs).
 */
async function checkDependencies(): Promise<DepStatus> {
  if (cachedDepStatus) {
    return cachedDepStatus;
  }

  // Fast path: check well-known binary locations (instant, no network)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const denoWellKnown =
    process.platform === "win32"
      ? `${home}\\.deno\\bin\\deno.exe`
      : `${home}/.deno/bin/deno`;
  const glubeanWellKnown =
    process.platform === "win32"
      ? `${home}\\.deno\\bin\\glubean.exe`
      : `${home}/.deno/bin/glubean`;

  let deno = fs.existsSync(denoWellKnown);
  let glubean = fs.existsSync(glubeanWellKnown);
  let denoTooOld = false;

  // Fallback: check PATH for non-standard installs (e.g. brew, scoop)
  if (!deno) {
    deno = await commandExists("deno");
  }

  // If Deno exists, verify it meets the minimum version requirement.
  // Deno 1.x uses different `deno install` flags and may not support JSR.
  if (deno) {
    const denoCmd = denoPath();
    const version = await getCommandVersion(denoCmd);
    if (version && !denoVersionOk(version)) {
      denoTooOld = true;
      deno = false; // Treat as missing so runSetup() will re-install
    }
  }

  // Fallback: check user-configured path or system PATH
  if (!glubean) {
    const config = vscode.workspace.getConfiguration("glubean");
    const configured = config.get<string>("glubeanPath", "glubean");
    if (configured !== "glubean") {
      // User set a custom path — check that specific path
      glubean = fs.existsSync(configured) || (await commandExists(configured));
    } else {
      // Default "glubean" — check if it's available on system PATH
      // (e.g. installed via brew, npm global, or manual symlink)
      glubean = await commandExists("glubean");
    }
  }

  // If CLI exists, check its version against MIN_CLI_VERSION.
  // Treat unparseable/empty version as outdated — better to prompt than silently skip.
  let cliVersion = "";
  let cliOutdated = false;
  if (glubean) {
    cliVersion = await getCliVersion(resolveGlubeanPath());
    if (!cliVersion || semverLessThan(cliVersion, MIN_CLI_VERSION)) {
      cliOutdated = true;
    }
  }

  cachedDepStatus = { deno, glubean, denoTooOld, cliVersion, cliOutdated };
  return cachedDepStatus;
}

/**
 * Run a shell command string and return stdout. Rejects on non-zero exit.
 * Only use for commands that genuinely need a shell (e.g. `curl ... | sh`).
 * For calling binaries with arguments, use {@link execBin} instead.
 */
function exec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? undefined : "/bin/sh";
    cp.exec(command, { shell, timeout: 240_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Run a binary with an args array — no shell involved.
 * Safe for paths containing spaces, $, backticks, etc.
 */
function execBin(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(bin, args, { timeout: 240_000, cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Resolve the path to Deno binary.
 * After a fresh install, ~/.deno/bin/deno may not be on the inherited PATH,
 * so we check the well-known location as a fallback.
 */
function denoPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const wellKnown =
    process.platform === "win32"
      ? `${home}\\.deno\\bin\\deno.exe`
      : `${home}/.deno/bin/deno`;

  if (fs.existsSync(wellKnown)) {
    return wellKnown;
  }
  return "deno"; // fall back to PATH
}

/**
 * Resolve the path to the Glubean CLI binary.
 *
 * Priority:
 * 1. User-configured `glubean.glubeanPath` setting (if non-default)
 * 2. `~/.deno/bin/glubean` well-known location (where `deno install` puts it)
 * 3. Bare `glubean` on PATH
 *
 * This prevents the "not found" loop after installation because VS Code's
 * shell environment often doesn't include ~/.deno/bin in PATH.
 */
function resolveGlubeanPath(): string {
  const config = vscode.workspace.getConfiguration("glubean");
  const configured = config.get<string>("glubeanPath", "glubean");

  // If user explicitly configured a custom path, respect it
  if (configured !== "glubean") {
    return configured;
  }

  // Check well-known Deno install location
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const wellKnown =
    process.platform === "win32"
      ? `${home}\\.deno\\bin\\glubean.exe`
      : `${home}/.deno/bin/glubean`;

  if (fs.existsSync(wellKnown)) {
    return wellKnown;
  }

  return "glubean"; // fall back to PATH
}

/**
 * Ensure ~/.deno/bin is on the user's shell PATH so `glubean` and `deno`
 * commands work in new terminal sessions.
 *
 * Supports:
 * - macOS: zsh (~/.zshrc), bash (~/.bash_profile)
 * - Linux: bash (~/.bashrc), zsh (~/.zshrc), fish (~/.config/fish/config.fish)
 * - Windows: adds to user-level PATH via registry
 * - Fallback: ~/.profile for unknown POSIX shells
 *
 * This mirrors what the Deno install script does, but is more reliable since
 * it runs regardless of how Deno was installed.
 */
async function ensureDenoOnPath(): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return;

  // ── Windows ──────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    const denoBinDir = `${home}\\.deno\\bin`;
    if (!fs.existsSync(denoBinDir)) return;

    // Check if already on PATH
    if ((process.env.PATH || "").includes(".deno\\bin")) return;

    // Add to user-level PATH via PowerShell (persists across sessions)
    try {
      await exec(
        `powershell -NoProfile -Command "` +
          `$current = [Environment]::GetEnvironmentVariable('Path', 'User'); ` +
          `if ($current -notlike '*\\.deno\\bin*') { ` +
          `[Environment]::SetEnvironmentVariable('Path', \\"$env:USERPROFILE\\.deno\\bin;$current\\", 'User') ` +
          `}"`,
      );
    } catch {
      // Non-critical — extension itself works via resolveGlubeanPath()
    }
    return;
  }

  // ── macOS / Linux ────────────────────────────────────────────────────
  const denoBinDir = `${home}/.deno/bin`;
  if (!fs.existsSync(denoBinDir)) return;

  // Detect the user's shell. SHELL env var is the login shell; if unavailable
  // (e.g. in some CI environments), check common rc files.
  const shell = process.env.SHELL || "";

  // Fish uses a different config syntax
  if (shell.endsWith("/fish")) {
    const fishConfigDir = `${home}/.config/fish`;
    const fishConfig = `${fishConfigDir}/config.fish`;

    try {
      const content = fs.existsSync(fishConfig)
        ? fs.readFileSync(fishConfig, "utf-8")
        : "";
      if (content.includes(".deno/bin")) return;

      // Ensure config directory exists
      if (!fs.existsSync(fishConfigDir)) {
        fs.mkdirSync(fishConfigDir, { recursive: true });
      }
      fs.appendFileSync(
        fishConfig,
        `\n# Added by Glubean extension\nfish_add_path $HOME/.deno/bin\n`,
      );
    } catch {
      // Non-critical
    }
    return;
  }

  // POSIX shells (zsh, bash, sh, etc.)
  const pathLine = 'export PATH="$HOME/.deno/bin:$PATH"';

  // Build a list of rc files to check/update, ordered by priority.
  // We update only the first one that exists (or create the most appropriate one).
  const rcCandidates: string[] = [];

  if (shell.endsWith("/zsh") || (!shell && process.platform === "darwin")) {
    // macOS defaults to zsh since Catalina; Linux zsh users have SHELL set
    rcCandidates.push(`${home}/.zshrc`);
  } else if (shell.endsWith("/bash")) {
    if (process.platform === "darwin") {
      // macOS bash reads .bash_profile for login shells (Terminal.app)
      rcCandidates.push(`${home}/.bash_profile`);
    }
    rcCandidates.push(`${home}/.bashrc`);
  }

  // Always include .profile as a fallback (read by most POSIX login shells)
  rcCandidates.push(`${home}/.profile`);

  // Also check common rc files that might already have it, even if not the
  // user's current shell — avoids duplicating the entry on shell switches
  const allRcFiles = [
    `${home}/.zshrc`,
    `${home}/.zprofile`,
    `${home}/.bashrc`,
    `${home}/.bash_profile`,
    `${home}/.profile`,
  ];

  // If any rc file already has .deno/bin, we're done
  for (const rc of allRcFiles) {
    try {
      const content = fs.readFileSync(rc, "utf-8");
      if (content.includes(".deno/bin")) return;
    } catch {
      // File doesn't exist — continue
    }
  }

  // Append to the first candidate (create if needed)
  const targetRc = rcCandidates[0];
  try {
    fs.appendFileSync(
      targetRc,
      `\n# Added by Glubean extension\n${pathLine}\n`,
    );
  } catch {
    // Extension itself works via resolveGlubeanPath(), but terminal won't.
    // Show a one-time tip so the user knows how to fix it manually.
    vscode.window.showInformationMessage(
      `Glubean works in the editor, but could not update ${targetRc} for terminal access. ` +
        'Add `export PATH="$HOME/.deno/bin:$PATH"` to your shell config manually.',
    );
  }
}

/**
 * One-click setup: install Deno (if missing) and Glubean CLI.
 * Runs silently with a VS Code progress notification.
 * Returns true if setup completed successfully.
 */
async function runSetup(): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Setting up Glubean",
      cancellable: false,
    },
    async (progress) => {
      try {
        const status = await checkDependencies();

        // Step 1: Install Deno if missing or too old
        if (!status.deno) {
          progress.report({
            message: status.denoTooOld
              ? "Upgrading Deno runtime..."
              : "Installing Deno runtime...",
          });

          if (process.platform === "win32") {
            await exec(
              'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://deno.land/install.ps1 | iex"',
            );
          } else {
            // Prefer curl; fall back to wget for minimal Linux installs
            const downloader = (await commandExists("curl"))
              ? "curl -fsSL https://deno.land/install.sh | sh"
              : "wget -qO- https://deno.land/install.sh | sh";
            await exec(downloader);
          }

          // Verify Deno is now available
          const deno = denoPath();
          try {
            await execBin(deno, ["--version"]);
          } catch {
            vscode.window.showErrorMessage(
              "Deno installation succeeded but the binary was not found. " +
                "You may need to restart VS Code so your PATH is updated.",
            );
            return false;
          }
        }

        // Step 2: Install Glubean CLI
        if (!status.glubean) {
          progress.report({ message: "Installing Glubean CLI..." });

          const deno = denoPath();
          await execBin(deno, ["install", "-Agf", "--reload", "-n", "glubean", "jsr:@glubean/cli"]);
        }

        // Step 3: Ensure ~/.deno/bin is on the user's shell PATH so
        // `glubean` and `deno` work in terminal sessions too
        progress.report({ message: "Configuring PATH..." });
        await ensureDenoOnPath();

        // Clear cache and verify installation in-place (no window reload needed
        // because resolveGlubeanPath() checks ~/.deno/bin directly)
        cachedDepStatus = undefined;
        progress.report({ message: "Verifying installation..." });

        const verified = await checkDependencies();
        if (verified.deno && verified.glubean) {
          progress.report({ message: "Ready!" });
          await new Promise((r) => setTimeout(r, 600));
          vscode.window.showInformationMessage(
            "Glubean is ready — run tests with the ▶ play button. " +
              "Open a new terminal for `glubean` CLI access.",
          );
          // Hide the setup status bar hint if it's showing
          setupStatusBarItem?.hide();
          return true;
        }

        // Installation completed but verification failed — suggest restart as last resort
        vscode.window.showWarningMessage(
          "Glubean was installed but could not be verified. " +
            "Try reloading VS Code (Cmd+Shift+P → Reload Window).",
        );
        return false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const shortcut =
          process.platform === "darwin" ? "Cmd+Shift+P" : "Ctrl+Shift+P";
        const choice = await vscode.window.showErrorMessage(
          `Glubean setup failed: ${message}`,
          "Open Install Guide",
          "Retry",
        );
        if (choice === "Open Install Guide") {
          await showSetupDoc();
        } else if (choice === "Retry") {
          cachedDepStatus = undefined;
          return await runSetup();
        }
        return false;
      }
    },
  );
}

/**
 * Upgrade the Glubean CLI to the latest version via `deno install -Agf`.
 * Shows a progress notification and clears the dep cache on success.
 */
async function upgradeGlubeanCli(): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Upgrading Glubean CLI",
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: `Installing latest CLI (requires ≥${MIN_CLI_VERSION})...` });
        const deno = denoPath();
        await execBin(deno, ["install", "-Agf", "--reload", "-n", "glubean", "jsr:@glubean/cli"]);

        // Verify upgrade succeeded
        progress.report({ message: "Verifying..." });
        const newVersion = await getCliVersion(resolveGlubeanPath());
        if (newVersion && !semverLessThan(newVersion, MIN_CLI_VERSION)) {
          cachedDepStatus = undefined;
          vscode.window.showInformationMessage(
            `Glubean CLI upgraded to ${newVersion}.`,
          );
          return true;
        }

        vscode.window.showWarningMessage(
          `CLI upgrade completed but version (${newVersion || "unknown"}) ` +
            `is still below ${MIN_CLI_VERSION}. Try reloading VS Code.`,
        );
        return false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`CLI upgrade failed: ${message}`);
        return false;
      }
    },
  );
}

/**
 * Show the setup.md explainer, then offer to continue with installation.
 */
async function showSetupDoc(): Promise<boolean> {
  const ext = vscode.extensions.getExtension("glubean.glubean");
  const baseUri = ext?.extensionUri ?? selfExtensionUri;
  if (!baseUri) {
    vscode.window.showErrorMessage(
      "Could not locate the extension docs. Please open README for setup steps.",
    );
    return false;
  }

  const docUri = vscode.Uri.joinPath(
    baseUri,
    "docs",
    "setup.md",
  );

  try {
    await vscode.commands.executeCommand("markdown.showPreview", docUri);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to open setup guide: ${message}`);
    return false;
  }

  const choice = await vscode.window.showInformationMessage(
    "Ready to install?",
    "Continue",
    "Not now",
  );

  if (choice === "Continue") {
    return await runSetup();
  }
  return false;
}

/**
 * Prompt the user to install missing dependencies.
 *
 * Single prompt, non-persistent — dismissed prompts re-appear next time the
 * user tries to run a test or on next VS Code session. This avoids the need
 * for a "don't ask again" option.
 *
 * Returns true if all dependencies are satisfied.
 */
async function promptInstallIfNeeded(): Promise<boolean> {
  const status = await checkDependencies();

  if (status.deno && status.glubean) {
    return true;
  }

  // Prevent stacking multiple prompts
  if (setupInProgress) {
    return false;
  }
  setupInProgress = true;

  try {
    // Tailor the message to what's actually missing
    const message = status.denoTooOld
      ? "Glubean requires Deno 2.0+. Click Continue to upgrade automatically."
      : !status.deno && !status.glubean
        ? "Glubean needs a one-time setup to run TypeScript natively (~30s)."
        : !status.deno
          ? "Glubean needs to install a TypeScript runtime (Deno) to run your tests."
          : "Glubean CLI is not installed. Set it up to enable play buttons and test running.";

    const choice = await vscode.window.showInformationMessage(
      message,
      "Continue",
      "Learn more",
    );

    if (choice === "Continue") {
      return await runSetup();
    }

    if (choice === "Learn more") {
      return await showSetupDoc();
    }

    return false;
  } finally {
    setupInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Environment switcher
// ---------------------------------------------------------------------------

/** Currently selected .env file (relative to workspace root). */
let selectedEnvFile: string | undefined;

/** Status bar item showing the active environment. */
let envStatusBarItem: vscode.StatusBarItem;

/**
 * Get the currently selected env file path (relative to workspace root).
 * Returns undefined when using the default .env.
 */
export function getSelectedEnvFile(): string | undefined {
  return selectedEnvFile;
}

/**
 * Derive a short display name from an env file path.
 * ".env" → "default", ".env.staging" → "staging", ".env.prod" → "prod"
 */
function envDisplayName(envFile: string): string {
  if (envFile === ".env") return "default";
  const match = envFile.match(/^\.env\.(.+)$/);
  return match ? match[1] : envFile;
}

/**
 * Detect .env* files in the workspace root.
 * Returns file names like [".env", ".env.dev", ".env.staging", ".env.prod"].
 */
async function detectEnvFiles(): Promise<string[]> {
  const folder = await pickWorkspaceFolder();
  const workspaceRoot = folder?.uri.fsPath;
  if (!workspaceRoot) return [".env"];

  try {
    const entries = fs.readdirSync(workspaceRoot);
    const envFiles = entries
      .filter(
        (f) =>
          f === ".env" ||
          (f.startsWith(".env.") &&
            !f.endsWith(".secrets") &&
            !f.endsWith(".local") &&
            !f.endsWith(".example")),
      )
      .sort();
    return envFiles.length > 0 ? envFiles : [".env"];
  } catch {
    return [".env"];
  }
}

/**
 * Initialize the environment status bar item and picker command.
 */
function activateEnvSwitcher(context: vscode.ExtensionContext): void {
  // Restore previous selection from workspace state
  selectedEnvFile = context.workspaceState.get<string>(
    "glubean.selectedEnvFile",
  );

  // Create status bar item
  envStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  envStatusBarItem.command = "glubean.selectEnv";
  envStatusBarItem.tooltip = "Glubean: Select environment (.env file)";
  updateEnvStatusBar();
  envStatusBarItem.show();
  context.subscriptions.push(envStatusBarItem);

  // Register the picker command
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.selectEnv", async () => {
      const envFiles = await detectEnvFiles();

      const items = envFiles.map((f) => ({
        label: envDisplayName(f),
        description: f,
        picked: (selectedEnvFile || ".env") === f,
      }));

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: "Select environment",
        title: "Glubean Environment",
      });

      if (choice) {
        selectedEnvFile =
          choice.description === ".env" ? undefined : choice.description;
        context.workspaceState.update(
          "glubean.selectedEnvFile",
          selectedEnvFile,
        );
        updateEnvStatusBar();
      }
    }),
  );
}

/** Update the status bar text to reflect the current environment. */
function updateEnvStatusBar(): void {
  const label = envDisplayName(selectedEnvFile || ".env");
  envStatusBarItem.text = `$(server-environment) env: ${label}`;
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  selfExtensionUri = context.extensionUri;

  // Activate the Test Controller (discovery + run)
  testController.activate(context);

  // Session-level PATH fallback so integrated terminals find glubean/deno
  // even when shell rc writes fail or a non-login shell is used.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    const sep = process.platform === "win32" ? "\\" : "/";
    const denoBin = `${home}${sep}.deno${sep}bin`;
    if (fs.existsSync(denoBin)) {
      const delimiter = process.platform === "win32" ? ";" : ":";
      context.environmentVariableCollection.prepend("PATH", denoBin + delimiter);
    }
  }

  // Wire up pre-run dependency check — blocks test execution if deps are missing
  testController.setPreRunCheck(promptInstallIfNeeded);

  // Wire up glubean path provider — so testController uses the resolved path
  // (with ~/.deno/bin fallback) instead of just the bare "glubean" command
  testController.setGlubeanPathProvider(resolveGlubeanPath);

  // ── Environment switcher ───────────────────────────────────────────────
  activateEnvSwitcher(context);
  testController.setEnvFileProvider(getSelectedEnvFile);

  // ── Hover provider (vars/secrets preview) ─────────────────────────────
  const hoverSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "typescript", pattern: "**/*.explore.ts" },
  ];
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      hoverSelector,
      createHoverProvider(getSelectedEnvFile),
    ),
  );

  // ── CodeLens providers ──────────────────────────────────────────────────
  const codeLensSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "typescript", pattern: "**/*.explore.ts" },
  ];

  // Trace history buttons (shown on all tests)
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      codeLensSelector,
      createTraceCodeLensProvider(),
    ),
  );

  // test.pick example buttons
  const pickCodeLensProvider = createPickCodeLensProvider(
    "glubean.runPick",
    "glubean.pickAndRun",
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      codeLensSelector,
      pickCodeLensProvider,
    ),
    pickCodeLensProvider,
  );

  // ── Trace navigator (StatusBar + prev/next) ────────────────────────────
  activateTraceNavigator(context);

  // ── Dependency check on activation (non-intrusive) ─────────────────────
  // Instead of popping up a dialog immediately, show a subtle status bar
  // hint. The full install prompt only appears when the user actually tries
  // to run a test (via preRunCheck).
  setupStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  setupStatusBarItem.command = "glubean.checkDependencies";
  context.subscriptions.push(setupStatusBarItem);

  void (async () => {
    try {
      const depStatus = await checkDependencies();

      if (!depStatus.deno || !depStatus.glubean) {
        setupStatusBarItem!.text = "$(warning) Glubean: Setup needed";
        setupStatusBarItem!.tooltip =
          "Click to install Glubean CLI and its dependencies";
        setupStatusBarItem!.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        setupStatusBarItem!.show();
      }

      // If deps are installed but PATH may not be configured yet (e.g. user
      // installed Deno/Glubean outside of the extension, or the extension
      // found them via the ~/.deno/bin fallback), ensure the shell rc files
      // have the PATH entry so `glubean` works in terminal sessions too.
      // This is idempotent — it checks before writing.
      if (depStatus.deno || depStatus.glubean) {
        await ensureDenoOnPath();
      }

      // ── Empty workspace detection (suggest init) ────────────────────────
      // If the workspace has no deno.json with glubean config, offer to
      // scaffold a minimal project. Runs once on activation, non-intrusively.
      if (!depStatus.deno || !depStatus.glubean) return;

      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return;

      const hasGlubeanProject = folders.some((folder) => {
        const root = folder.uri.fsPath;
        for (const name of ["deno.json", "deno.jsonc"]) {
          const configPath = path.join(root, name);
          if (fs.existsSync(configPath)) {
            try {
              const content = fs.readFileSync(configPath, "utf-8");
              if (
                content.includes("@glubean/sdk") || content.includes('"glubean"')
              ) {
                return true;
              }
            } catch {
              // unreadable — skip
            }
          }
        }
        return false;
      });

      if (!hasGlubeanProject) {
        const choice = await vscode.window.showInformationMessage(
          "No Glubean project detected. Initialize one?",
          "Quick Start",
          "Not now",
        );
        if (choice === "Quick Start") {
          await vscode.commands.executeCommand("glubean.initProject");
        }
      }

      // ── CLI version check (prompt upgrade if outdated or unknown) ─────
      if (depStatus.cliOutdated) {
        const installed = depStatus.cliVersion;
        const msg = installed
          ? `Glubean CLI ${installed} is outdated (extension requires ≥${MIN_CLI_VERSION}). Upgrade now?`
          : `Could not determine Glubean CLI version (extension requires ≥${MIN_CLI_VERSION}). Upgrade now?`;
        const choice = await vscode.window.showWarningMessage(
          msg,
          "Upgrade",
          "Later",
        );
        if (choice === "Upgrade") {
          await upgradeGlubeanCli();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Glubean] activation dependency check failed: ${message}`);
    }
  })();

  // ── Commands ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.runFile",
      async (resource?: vscode.Uri) => {
        // Support invocation from explorer context menu (resource arg)
        // or from editor title button / command palette (active editor)
        const uri =
          resource ?? vscode.window.activeTextEditor?.document.uri;
        const fileName = uri?.fsPath ?? "";
        if (
          !uri ||
          (!fileName.endsWith(".test.ts") && !fileName.endsWith(".explore.ts"))
        ) {
          vscode.window.showWarningMessage(
            "Open a .test.ts or .explore.ts file to run.",
          );
          return;
        }

        await testController.runFileByUri(uri);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.runProject",
      async (resource?: vscode.Uri) => {
        const targetUri =
          resource ??
          vscode.window.activeTextEditor?.document.uri;
        const folder = targetUri
          ? vscode.workspace.getWorkspaceFolder(targetUri)
          : undefined;
        const workspaceFolder =
          folder ?? vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
          vscode.window.showWarningMessage("No workspace folder open.");
          return;
        }

        await testController.runAll(workspaceFolder);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.openLastResult", async () => {
      const resultPath = testController.getLastResultJsonPath();
      if (!resultPath || !fs.existsSync(resultPath)) {
        vscode.window.showInformationMessage(
          "No result JSON available. Run a test first.",
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(resultPath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.checkDependencies", async () => {
      cachedDepStatus = undefined; // clear cache
      const status = await checkDependencies();
      if (status.deno && status.glubean) {
        // Deps found — also ensure PATH is configured (self-healing)
        await ensureDenoOnPath();
        setupStatusBarItem?.hide();
        vscode.window.showInformationMessage(
          "Glubean: All dependencies are installed.",
        );
      } else {
        await runSetup();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.initProject", async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const depsOk = await promptInstallIfNeeded();
      if (!depsOk) return;

      try {
        const glubeanPath = resolveGlubeanPath();
        await execBin(glubeanPath, ["init", "--minimal", "--no-interactive"], folder.uri.fsPath);

        const exploreFile = vscode.Uri.joinPath(folder.uri, "explore", "api.test.ts");
        if (fs.existsSync(exploreFile.fsPath)) {
          const doc = await vscode.workspace.openTextDocument(exploreFile);
          await vscode.window.showTextDocument(doc);
        }

        vscode.window.showInformationMessage(
          "Glubean project initialized — run explore/api.test.ts with the ▶ play button.",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Glubean init failed: ${message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.rerunLast", async () => {
      const ok = await testController.rerunLast();
      if (!ok) {
        vscode.window.showInformationMessage(
          "No previous run to repeat. Run a test or explore first.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.diffPrevious", async () => {
      const ok = await testController.diffWithPrevious();
      if (!ok) {
        vscode.window.showInformationMessage(
          "Need at least two previous runs to diff. Run again first.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.cleanTraces", async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }
      const workspaceRoot = folder.uri.fsPath;

      const tracesDir = `${workspaceRoot}/.glubean/traces`;
      if (!fs.existsSync(tracesDir)) {
        vscode.window.showInformationMessage("No trace files to clean.");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        "Delete all trace history in .glubean/traces/?",
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;

      try {
        fs.rmSync(tracesDir, { recursive: true, force: true });
        vscode.window.showInformationMessage("All trace files cleaned.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clean traces: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.copyAsCurl", async () => {
      const ok = await testController.copyAsCurl();
      if (ok) {
        vscode.window.showInformationMessage(
          "cURL command copied to clipboard.",
        );
      } else {
        vscode.window.showWarningMessage(
          "Open a .trace.jsonc file to copy as cURL.",
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.runPick",
      async (args: {
        filePath: string;
        testId: string;
        exportName: string;
        pickKey?: string;
      }) => {
        if (!args?.filePath) {
          vscode.window.showWarningMessage("No file specified for pick run.");
          return;
        }
        await testController.runWithPick(
          args.filePath,
          args.testId,
          args.pickKey,
        );
      },
    ),
  );

  // QuickPick-based pick selection (for many examples)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.pickAndRun",
      async (args: {
        filePath: string;
        testId: string;
        exportName: string;
        keys: string[];
      }) => {
        if (!args?.keys?.length) {
          return;
        }

        // Build items: "Run All" at top, then individual keys
        const allItem: vscode.QuickPickItem = {
          label: `$(run-all) Run All (${args.keys.length})`,
          description: "Run every example",
        };
        const keyItems: vscode.QuickPickItem[] = args.keys.map((k) => ({
          label: k,
        }));

        const picked = await vscode.window.showQuickPick(
          [allItem, ...keyItems],
          {
            placeHolder: "Select examples to run",
            title: `Pick: ${args.testId}`,
            canPickMany: true,
          },
        );

        if (!picked || picked.length === 0) {
          return; // User cancelled
        }

        // If "Run All" is selected, pass "all" as the pick key
        const isAll = picked.some((p) => p === allItem);
        const pickKey = isAll
          ? "all"
          : picked.map((p) => p.label).join(",");

        await testController.runWithPick(
          args.filePath,
          args.testId,
          pickKey,
        );
      },
    ),
  );

  // Log activation
  const outputChannel = vscode.window.createOutputChannel("Glubean");
  outputChannel.appendLine("Glubean extension activated");
  context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
  // Nothing to clean up — VS Code disposes subscriptions automatically
}

