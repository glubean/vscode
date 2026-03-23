/**
 * Glubean VS Code Extension — main entry point.
 *
 * Activates the Test Controller for ▶ play buttons, Test Explorer sidebar,
 * and pass/fail status display in the gutter.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as testController from "./testController";
import { activateCliStatus } from "./cliStatus";
import { createHoverProvider } from "./hoverProvider";
import { createPickCodeLensProvider } from "./codeLensProvider";
import { createResultCodeLensProvider } from "./resultCodeLensProvider";
import { activateResultNavigator } from "./resultNavigator";
import { ResultViewerProvider } from "./resultViewerProvider";
import {
  initTelemetry,
  maybeAskConsent,
  shutdownTelemetry,
  track,
} from "./telemetry";
import { TasksProvider, type TaskItem, type PinnedFileItem, type PinnedTestItem } from "./taskPanel/provider";
import { TaskRunner } from "./taskPanel/runner";
import { initStorage } from "./taskPanel/storage";
import { initPinnedStorage, pinFile, unpinFile, listPinned, isPinned, type PinnedFile } from "./pinnedFiles";
import { initPinnedTestStorage, pinTest, unpinTest, listPinnedTests, isPinnedTest, type PinnedTest } from "./pinnedTests";
import { runDiagnose } from "./diagnose";
import { registerAiRefactorCommand } from "./aiRefactor";

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
  activateCliStatus(context);
  testController.setEnvFileProvider(getSelectedEnvFile);

  // ── Hover provider (vars/secrets preview) ─────────────────────────────
  const hoverSelector: vscode.DocumentSelector = [
    { language: "typescript", pattern: "**/*.test.ts" },
    { language: "javascript", pattern: "**/*.test.{js,mjs}" },
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
    { language: "javascript", pattern: "**/*.test.{js,mjs}" },
  ];

  // Result history buttons (shown on all tests)
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      codeLensSelector,
      createResultCodeLensProvider(),
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

  // ── Result navigator (StatusBar + prev/next) ────────────────────────────
  activateResultNavigator(context);

  // ── Tasks panel (Activity Bar view for QA) ─────────────────────────────
  initStorage(context.workspaceState);
  initPinnedStorage(context.workspaceState);
  initPinnedTestStorage(context.workspaceState);
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

  // ── Pinned files commands ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.pinFile",
      async (resource?: vscode.Uri) => {
        const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          vscode.window.showWarningMessage("No file selected to pin.");
          return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
          vscode.window.showWarningMessage("File is not inside a workspace folder.");
          return;
        }

        const workspaceRoot = folder.uri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const label = relativePath.split("/").pop() ?? relativePath;

        if (isPinned(listPinned(), workspaceRoot, relativePath)) {
          vscode.window.showInformationMessage(`${label} is already pinned.`);
          return;
        }

        const entry: PinnedFile = {
          type: "file",
          workspaceRoot,
          filePath: relativePath,
          label,
        };

        await pinFile(entry);
        tasksProvider.refresh();
        track("pin_file");
      },
    ),
    vscode.commands.registerCommand(
      "glubean.unpinFile",
      async (item?: PinnedFileItem) => {
        if (!item?.pinned) {
          vscode.window.showWarningMessage("No pinned file selected.");
          return;
        }

        await unpinFile(item.pinned.workspaceRoot, item.pinned.filePath);
        tasksProvider.refresh();
        track("unpin_file");
      },
    ),
    vscode.commands.registerCommand(
      "glubean.runPinnedFile",
      async (pinnedOrItem?: PinnedFile | PinnedFileItem) => {
        // Accept either a PinnedFile (from tree item click) or PinnedFileItem (from inline action)
        const pinned = pinnedOrItem && "pinned" in pinnedOrItem
          ? (pinnedOrItem as PinnedFileItem).pinned
          : pinnedOrItem as PinnedFile | undefined;

        if (!pinned?.filePath || !pinned?.workspaceRoot) {
          vscode.window.showWarningMessage("No pinned file to run.");
          return;
        }

        const { join } = await import("node:path");
        const absolutePath = join(pinned.workspaceRoot, pinned.filePath);
        const uri = vscode.Uri.file(absolutePath);
        await testController.runFileByUri(uri);
      },
    ),
  );

  // ── Pinned tests commands ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.pinTest",
      async (args?: { uri: vscode.Uri; testId: string; exportName: string; label: string }) => {
        if (!args?.uri || !args?.testId) {
          vscode.window.showWarningMessage("No test selected to pin.");
          return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(args.uri);
        if (!folder) {
          vscode.window.showWarningMessage("File is not inside a workspace folder.");
          return;
        }

        const workspaceRoot = folder.uri.fsPath;
        const relativePath = vscode.workspace.asRelativePath(args.uri, false);

        if (isPinnedTest(listPinnedTests(), workspaceRoot, relativePath, args.testId)) {
          vscode.window.showInformationMessage(`${args.label} is already pinned.`);
          return;
        }

        const entry: PinnedTest = {
          type: "test",
          workspaceRoot,
          filePath: relativePath,
          testId: args.testId,
          exportName: args.exportName,
          label: args.label,
        };

        await pinTest(entry);
        tasksProvider.refresh();
        track("pin_test");
      },
    ),
    vscode.commands.registerCommand(
      "glubean.unpinTest",
      async (item?: PinnedTestItem) => {
        if (!item?.pinned) {
          vscode.window.showWarningMessage("No pinned test selected.");
          return;
        }

        await unpinTest(item.pinned.workspaceRoot, item.pinned.filePath, item.pinned.testId);
        tasksProvider.refresh();
        track("unpin_test");
      },
    ),
    vscode.commands.registerCommand(
      "glubean.runPinnedTest",
      async (pinnedOrItem?: PinnedTest | PinnedTestItem) => {
        // Accept either a PinnedTest or PinnedTestItem (from inline action)
        const pinned = pinnedOrItem && "pinned" in pinnedOrItem
          ? (pinnedOrItem as PinnedTestItem).pinned
          : pinnedOrItem as PinnedTest | undefined;

        if (!pinned?.filePath || !pinned?.workspaceRoot || !pinned?.testId) {
          vscode.window.showWarningMessage("No pinned test to run.");
          return;
        }

        const { join } = await import("node:path");
        const absolutePath = join(pinned.workspaceRoot, pinned.filePath);
        await testController.rerunFailed(absolutePath, [pinned.testId]);
      },
    ),
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
          !/\.test\.(ts|js|mjs)$/.test(fileName)
        ) {
          vscode.window.showWarningMessage(
            "Open a .test.ts, .test.js, or .test.mjs file to run.",
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
    vscode.commands.registerCommand("glubean.initProject", async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Initialize a Glubean Project

## Quick Start

Run the following command in your terminal:

\`\`\`bash
npx @glubean/cli@latest init
\`\`\`

This will scaffold a project with:
- \`package.json\` with \`@glubean/sdk\` dependency
- \`tsconfig.json\` configured for TypeScript tests
- \`.env\` and \`.env.secrets\` for environment variables
- \`tests/\` directory with a starter test file
- AI instruction files for Claude / ChatGPT / Copilot

## Two Ways to Write Tests

### 1. Quick Mode — simple, flat tests

\`\`\`typescript
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const res = await ctx.http.get("https://api.example.com/health");
  ctx.expect(res.status).toBe(200);
});
\`\`\`

### 2. Builder Mode — multi-step workflows with setup/teardown

\`\`\`typescript
import { test } from "@glubean/sdk";

export const userFlow = test("user-flow")
  .setup(async (ctx) => {
    const token = await login(ctx);
    return { token };
  })
  .step("create user", async (ctx, { token }) => {
    // ...
  })
  .step("verify user", async (ctx, state) => {
    // ...
  })
  .teardown(async (ctx, state) => {
    // cleanup
  })
  .build();
\`\`\`

## Cookbook & Examples

Browse real-world examples at:
https://github.com/glubean/cookbook

Includes patterns for:
- REST API testing (CRUD, auth, pagination)
- GraphQL queries and mutations
- Browser automation with Puppeteer
- Data-driven tests (CSV, JSON)
- Multi-step workflow verification

## Next Steps

1. Run \`npx @glubean/cli@latest init\` in your terminal
2. Open the generated \`.test.ts\` file
3. Click the ▶ button to run your first test
`,
      });
      await vscode.window.showTextDocument(doc, { preview: true });

      // Also open terminal with the init command ready
      const terminal = vscode.window.createTerminal("Glubean Init");
      terminal.show();
      terminal.sendText("npx @glubean/cli@latest init", false);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.checkDependencies", async () => {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const { stdout } = await exec("node", ["--version"]);
        const version = stdout.trim();
        const major = parseInt(version.replace("v", ""), 10);
        if (major >= 20) {
          vscode.window.showInformationMessage(
            `Node.js ${version} detected. You're all set!`,
          );
        } else {
          vscode.window.showWarningMessage(
            `Node.js ${version} detected but 20+ is required.`,
            "Download Node.js",
          ).then((choice) => {
            if (choice === "Download Node.js") {
              vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
            }
          });
        }
      } catch {
        vscode.window.showErrorMessage(
          "Node.js not found. Glubean requires Node.js 20+ to run tests.",
          "Download Node.js",
        ).then((choice) => {
          if (choice === "Download Node.js") {
            vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
          }
        });
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

  // Rerun failed tests — called from result viewer webview or command palette
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.rerunFailed",
      async (args?: { filePath: string; testIds: string[] }) => {
        if (args?.filePath && args?.testIds?.length) {
          await testController.rerunFailed(args.filePath, args.testIds);
          return;
        }

        // Command palette mode — read last result and extract failed IDs
        const { readResultJson } = await import("./testController/results");
        const { extractFailedTestIds, inferSourcePath } = await import("./resultViewerUtils");

        const resultPath = testController.getLastResultJsonPath();
        if (!resultPath || !fs.existsSync(resultPath)) {
          vscode.window.showInformationMessage(
            "No result available. Run tests first.",
          );
          return;
        }

        const result = readResultJson(resultPath);
        const failedIds = extractFailedTestIds(result);
        if (failedIds.length === 0) {
          vscode.window.showInformationMessage(
            "All tests passed — nothing to rerun.",
          );
          return;
        }

        const sourcePath = inferSourcePath(resultPath);
        if (!sourcePath) {
          vscode.window.showWarningMessage(
            "Could not locate the source test file.",
          );
          return;
        }

        await testController.rerunFailed(sourcePath, failedIds);
      },
    ),
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
    vscode.commands.registerCommand("glubean.cleanResults", async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }
      const workspaceRoot = folder.uri.fsPath;

      const resultsDir = `${workspaceRoot}/.glubean/results`;
      if (!fs.existsSync(resultsDir)) {
        vscode.window.showInformationMessage("No result files to clean.");
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        "Delete all result history in .glubean/results/?",
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;

      try {
        fs.rmSync(resultsDir, { recursive: true, force: true });
        vscode.window.showInformationMessage("All result files cleaned.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to clean results: ${msg}`);
      }
    }),
  );

  // Open data file below the current editor (split down)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "glubean.openDataFile",
      async (uri: vscode.Uri) => {
        if (!uri) return;

        const sourceColumn = vscode.window.activeTextEditor?.viewColumn;

        // Try to focus the group below
        const groupsBefore = vscode.window.tabGroups.all.length;
        await vscode.commands.executeCommand(
          "workbench.action.focusBelowGroup",
        );
        const movedDown =
          vscode.window.tabGroups.activeTabGroup.viewColumn !== sourceColumn;

        if (!movedDown) {
          // No group below — create one
          await vscode.commands.executeCommand(
            "workbench.action.newGroupBelow",
          );
        }

        // Open data file in the now-active group (below source)
        await vscode.window.showTextDocument(uri, {
          viewColumn: vscode.ViewColumn.Active,
          preview: true,
        });

        // Restore focus to source editor above
        if (sourceColumn) {
          await vscode.commands.executeCommand(
            "workbench.action.focusAboveGroup",
          );
        }
      },
    ),
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
          "Open a .result.json file to copy as cURL.",
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
            args.exportName,
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
            args.exportName,
          );
        } finally {
          pickCodeLensProvider.clearRunning(args.filePath, args.testId);
        }
      },
    ),
  );

  // Log activation
  const outputChannel = vscode.window.createOutputChannel("Glubean");
  outputChannel.appendLine("Glubean extension activated — DEV BUILD " + new Date().toLocaleString());
  context.subscriptions.push(outputChannel);

  // ── AI Refactor command ──────────────────────────────────────────────────
  registerAiRefactorCommand(context);

  // ── Diagnose command ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("glubean.diagnose", async () => {
      await runDiagnose(outputChannel);
      outputChannel.show();
    }),
  );
}

export function deactivate(): void {
  void shutdownTelemetry();
}
