/**
 * Glubean VS Code Extension — main entry point.
 *
 * Activates the Test Controller for ▶ play buttons, Test Explorer sidebar,
 * and pass/fail status display in the gutter.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as cp from "child_process";
import * as testController from "./testController";
import { createHoverProvider } from "./hoverProvider";
import { createPickCodeLensProvider } from "./codeLensProvider";

// ---------------------------------------------------------------------------
// Dependency detection & one-click setup
// ---------------------------------------------------------------------------

interface DepStatus {
  deno: boolean;
  glubean: boolean;
}

/** Cache so we only check once per session (cleared by "Setup" action). */
let cachedDepStatus: DepStatus | undefined;

/** Prevent multiple setup prompts from stacking. */
let setupInProgress = false;

/** Status bar item shown when setup is needed (non-intrusive alternative to popup). */
let setupStatusBarItem: vscode.StatusBarItem | undefined;

/**
 * Check whether a command is available on the system PATH.
 * Returns true if the command exits with code 0.
 */
function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = cp.spawn(command, ["--version"], {
      shell: true,
      stdio: "ignore",
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Detect whether Deno and Glubean CLI are installed.
 * Uses resolveGlubeanPath() which checks well-known install locations
 * as fallback, so we don't depend on ~/.deno/bin being on PATH.
 */
async function checkDependencies(): Promise<DepStatus> {
  if (cachedDepStatus) {
    return cachedDepStatus;
  }

  const glubeanPath = resolveGlubeanPath();
  const [deno, glubean] = await Promise.all([
    commandExists(denoPath()),
    commandExists(glubeanPath),
  ]);
  cachedDepStatus = { deno, glubean };
  return cachedDepStatus;
}

/**
 * Run a shell command and return stdout. Rejects on non-zero exit.
 * Uses login shell so ~/.deno/bin is on PATH after Deno install.
 */
function exec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? undefined : "/bin/sh";
    cp.exec(command, { shell, timeout: 120_000 }, (err, stdout, stderr) => {
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
    // Non-critical — extension itself works via resolveGlubeanPath()
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

        // Step 1: Install Deno if missing
        if (!status.deno) {
          progress.report({ message: "Installing Deno runtime..." });

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
            await exec(`"${deno}" --version`);
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
          await exec(`"${deno}" install -Agf -n glubean jsr:@glubean/cli`);
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
            "Glubean is ready — you can now run tests with the ▶ play button.",
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
        vscode.window.showErrorMessage(
          `Glubean setup failed: ${message}. ` +
            `You can retry with ${shortcut} → "Glubean: Setup".`,
        );
        return false;
      }
    },
  );
}

/**
 * Show the setup.md explainer, then offer to continue with installation.
 */
async function showSetupDoc(): Promise<boolean> {
  const docUri = vscode.Uri.joinPath(
    vscode.extensions.getExtension("glubean.glubean")!.extensionUri,
    "docs",
    "setup.md",
  );

  await vscode.commands.executeCommand("markdown.showPreview", docUri);

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
    const message =
      !status.deno && !status.glubean
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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  // Activate the Test Controller (discovery + run)
  testController.activate(context);

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

  // ── CodeLens provider (test.pick example buttons) ───────────────────────
  const codeLensSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "typescript", pattern: "**/*.explore.ts" },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      codeLensSelector,
      createPickCodeLensProvider("glubean.runPick"),
    ),
  );

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

  checkDependencies().then((status) => {
    if (!status.deno || !status.glubean) {
      setupStatusBarItem!.text = "$(warning) Glubean: Setup needed";
      setupStatusBarItem!.tooltip =
        "Click to install Glubean CLI and its dependencies";
      setupStatusBarItem!.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      setupStatusBarItem!.show();
    }

    // If deps are installed but PATH may not be configured yet (e.g. user
    // installed Deno/Glubean outside of the extension, or the extension
    // found them via the ~/.deno/bin fallback), ensure the shell rc files
    // have the PATH entry so `glubean` works in terminal sessions too.
    // This is idempotent — it checks before writing.
    if (status.deno || status.glubean) {
      ensureDenoOnPath();
    }
  });

  // ── Commands ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.runFile", async () => {
      const editor = vscode.window.activeTextEditor;
      const fileName = editor?.document.fileName ?? "";
      if (
        !editor ||
        (!fileName.endsWith(".test.ts") && !fileName.endsWith(".explore.ts"))
      ) {
        vscode.window.showWarningMessage(
          "Open a .test.ts or .explore.ts file to run.",
        );
        return;
      }

      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`glubean run "${editor.document.fileName}"`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.runWorkspace", async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const terminal = getOrCreateTerminal();
      terminal.show();
      terminal.sendText(`glubean run "${workspaceFolder.uri.fsPath}"`);
    }),
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
        vscode.window.showInformationMessage(
          "Glubean: All dependencies are installed.",
        );
      } else {
        await runSetup();
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

  // Log activation
  const outputChannel = vscode.window.createOutputChannel("Glubean");
  outputChannel.appendLine("Glubean extension activated");
  context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
  // Nothing to clean up — VS Code disposes subscriptions automatically
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reuse an existing "Glubean" terminal or create a new one.
 */
function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === "Glubean");
  if (existing) {
    return existing;
  }
  return vscode.window.createTerminal("Glubean");
}
