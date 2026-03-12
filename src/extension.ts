/**
 * Glubean VS Code Extension — main entry point.
 *
 * Activates the Test Controller for ▶ play buttons, Test Explorer sidebar,
 * and pass/fail status display in the gutter.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as testController from "./testController";
import { createHoverProvider } from "./hoverProvider";
import { createPickCodeLensProvider } from "./codeLensProvider";
import { createTraceCodeLensProvider } from "./traceCodeLensProvider";
import { activateTraceNavigator } from "./traceNavigator";
import { TraceViewerProvider } from "./traceViewerProvider";
import { ResultViewerProvider } from "./resultViewerProvider";
import {
  initTelemetry,
  maybeAskConsent,
  shutdownTelemetry,
  track,
} from "./telemetry";
import { TasksProvider, type TaskItem } from "./taskPanel/provider";
import { TaskRunner } from "./taskPanel/runner";
import { initStorage } from "./taskPanel/storage";

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
 * the user's interactive shell.
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
        track("env_switched");
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
  // ── Telemetry (opt-in, disabled by default) ─────────────────────────────
  initTelemetry(context);
  track("session_start");

  // Activate the Test Controller (discovery + run)
  testController.activate(context);


  // Wire up run complete listener — fires telemetry and the one-time consent
  // prompt after the user's first successful test run.
  testController.setRunCompleteListener((summary) => {
    void (async () => {
      await maybeAskConsent(context);
      track("test_run", {
        test_count: summary.testCount,
        duration_ms: summary.durationMs,
        location: summary.location,
      });
    })();
  });

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

  // ── Trace viewer (custom editor for .trace.jsonc) ──────────────────────
  // Track whether the next open is triggered by the user ("manual") or
  // programmatically after a test run ("auto"). The flag is set to "manual"
  // by the traceViewRich command before calling openWith, then consumed and
  // reset inside the onOpen callback.
  let nextTraceOpenVia: "auto" | "manual" = "auto";

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      TraceViewerProvider.viewType,
      new TraceViewerProvider(context.extensionUri, () => {
        const via = nextTraceOpenVia;
        nextTraceOpenVia = "auto";
        track("trace_opened", { via });
      }),
      { supportsMultipleEditorsPerDocument: false },
    ),
  );

  // Auto-redirect: when a .trace.jsonc file is opened as plain text (e.g. via
  // the file explorer), switch to the rich viewer automatically — unless it was
  // opened as part of a diff/compare operation or already open in the rich viewer.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!doc.uri.fsPath.endsWith(".trace.jsonc")) return;
      // Delay one event-loop tick so VS Code can finish wiring up the tab.
      setTimeout(() => {
        const docUriStr = doc.uri.toString();

        // If this file is already open in a custom editor anywhere, skip.
        // This prevents duplicates when openLatestTrace() already opened it.
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input = tab.input;
            if (
              input && typeof input === "object" &&
              "viewType" in input && "uri" in input &&
              (input as { uri: vscode.Uri }).uri.toString() === docUriStr
            ) {
              return;
            }
          }
        }

        // Not in a custom editor — find the plain text tab and redirect it.
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input = tab.input;
            if (!input || typeof input !== "object") continue;
            if ("original" in input && "modified" in input) continue;
            if ("uri" in input && (input as { uri: vscode.Uri }).uri.toString() === docUriStr) {
              void vscode.commands.executeCommand("vscode.openWith", doc.uri, TraceViewerProvider.viewType);
              return;
            }
          }
        }
      }, 50);
    }),
  );

  // Toggle buttons: switch between custom viewer and text editor
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.traceViewSource", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      const uri = input && typeof input === "object" && "uri" in input
        ? (input as { uri: vscode.Uri }).uri
        : undefined;
      if (uri) {
        void vscode.commands.executeCommand("vscode.openWith", uri, "default");
      }
    }),
    vscode.commands.registerCommand("glubean.traceViewRich", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) {
        nextTraceOpenVia = "manual";
        void vscode.commands.executeCommand("vscode.openWith", uri, TraceViewerProvider.viewType);
      }
    }),
  );

  // ── Result viewer (custom editor for .result.json) ───────────────────
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ResultViewerProvider.viewType,
      new ResultViewerProvider(context.extensionUri),
      { supportsMultipleEditorsPerDocument: false },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.resultViewSource", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      const uri = input && typeof input === "object" && "uri" in input
        ? (input as { uri: vscode.Uri }).uri
        : undefined;
      if (uri) {
        void vscode.commands.executeCommand("vscode.openWith", uri, "default");
      }
    }),
    vscode.commands.registerCommand("glubean.resultViewRich", () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) {
        void vscode.commands.executeCommand("vscode.openWith", uri, ResultViewerProvider.viewType);
      }
    }),
  );

  // ── Trace navigator (StatusBar + prev/next) ────────────────────────────
  activateTraceNavigator(context);

  // ── Tasks panel (Activity Bar view for QA) ─────────────────────────────
  initStorage(context.workspaceState);
  const tasksProvider = new TasksProvider();
  const taskRunner = new TaskRunner(tasksProvider);

  const tasksView = vscode.window.createTreeView("glubean.tasksView", {
    treeDataProvider: tasksProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(tasksView);

  const refreshTasks = () => {
    tasksProvider.refresh();
    void vscode.commands.executeCommand(
      "setContext",
      "glubean.hasTasks",
      tasksProvider.getAllTasks().length > 0,
    );
  };

  refreshTasks();
  taskRunner.activate(context.subscriptions);

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.tasks.run", (item: TaskItem) => {
      void taskRunner.runTask(item);
    }),
    vscode.commands.registerCommand("glubean.tasks.runAll", () => {
      void taskRunner.runAllRoots();
    }),
    vscode.commands.registerCommand("glubean.tasks.refresh", () => {
      refreshTasks();
    }),
  );

  const configWatcher = vscode.workspace.createFileSystemWatcher(
    "**/package.json",
  );
  configWatcher.onDidChange(() => refreshTasks());
  configWatcher.onDidCreate(() => refreshTasks());
  configWatcher.onDidDelete(() => refreshTasks());
  context.subscriptions.push(configWatcher);

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
    vscode.commands.registerCommand("glubean.checkDependencies", () => {
      vscode.window.showInformationMessage(
        "Glubean runs on Node.js (bundled with VS Code). No additional setup needed.",
      );
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
        pickCodeLensProvider.setRunning(args.filePath, args.testId);
        try {
          await testController.runWithPick(
            args.filePath,
            args.testId,
            args.pickKey,
          );
        } finally {
          pickCodeLensProvider.clearRunning(args.filePath, args.testId);
        }
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

        pickCodeLensProvider.setRunning(args.filePath, args.testId);
        try {
          await testController.runWithPick(
            args.filePath,
            args.testId,
            pickKey,
          );
        } finally {
          pickCodeLensProvider.clearRunning(args.filePath, args.testId);
        }
      },
    ),
  );

  // Log activation
  const outputChannel = vscode.window.createOutputChannel("Glubean");
  outputChannel.appendLine("Glubean extension activated");
  context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
  void shutdownTelemetry();
}

