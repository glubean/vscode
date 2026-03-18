/**
 * Glubean Test Controller for VS Code.
 *
 * Integrates with the VS Code Testing API to provide:
 * - ▶ play buttons in the gutter (line numbers)
 * - Test Explorer sidebar tree
 * - Pass/fail status icons
 * - Test Results panel
 *
 * Discovery: uses static regex parsing (parser.ts) on file open/save.
 * Execution: uses @glubean/runner directly via executor.ts.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  findFreePort,
  pollInspectorReady,
} from "./testController/debug-utils";
import { extractAliasesFromSource, extractTests, type TestMeta } from "./parser";
import { executeTest } from "./testController/executor";
import {
  applyResults,
  readResultJson,
} from "./testController/results";
import {
  diffWithPrevious as diffWithPreviousTrace,
} from "./testController/trace";
import { writeRunArtifacts } from "./testController/artifacts";
import {
  normalizeFilterId,
  tracePairToCurl,
  type TracePair,
} from "./testController.utils";

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace folder that contains the given file path.
 * Falls back to the file's own directory — this enables zero-project mode
 * for standalone test files that aren't inside any workspace folder.
 */
function workspaceRootFor(filePath: string): string {
  const fileUri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (folder) {
    return folder.uri.fsPath;
  }
  return path.dirname(filePath);
}

const resultModuleDeps = { workspaceRootFor };

/**
 * Detect scratch mode: file is not in any workspace folder, or cwd has no
 * node_modules/@glubean/sdk (runner will inject its own).
 */
function isScratchMode(filePath: string): boolean {
  const fileUri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!folder) return true;
  return !fs.existsSync(path.join(folder.uri.fsPath, "node_modules", "@glubean", "sdk"));
}

let scratchModeHintShown = false;

function showScratchModeHint(): void {
  if (scratchModeHintShown) return;
  scratchModeHintShown = true;

  vscode.window
    .showInformationMessage(
      "Running in scratch mode — great for trying things out! Run `npx @glubean/cli@latest init` to create a full project.",
      "Open Terminal",
      "Don't show again",
    )
    .then((choice) => {
      if (choice === "Open Terminal") {
        const terminal = vscode.window.createTerminal("Glubean");
        terminal.show();
        terminal.sendText("# Run: npx @glubean/cli@latest init", false);
      }
    });
}

// ---------------------------------------------------------------------------
// Controller setup
// ---------------------------------------------------------------------------

let controller: vscode.TestController;
let outputChannel: vscode.OutputChannel;

/** Map from file URI string to its TestItem */
const fileItems = new Map<string, vscode.TestItem>();

/** Root group nodes for Test Explorer tree */
let testsRoot: vscode.TestItem | undefined;
let exploreRoot: vscode.TestItem | undefined;
const projectNodes = new Map<string, vscode.TestItem>(); // "explore:root" or "tests:root" → project node

// ---------------------------------------------------------------------------
// Alias registry — auto-detected test.extend() / task.extend() function names
// ---------------------------------------------------------------------------

/**
 * Workspace-level set of custom function names discovered from `.extend()` calls.
 * e.g. `const browserTest = test.extend({...})` → adds "browserTest".
 * Passed to `isGlubeanFile()` and `extractTests()` so they recognize
 * `export const x = browserTest(...)` in test files.
 */
const aliasRegistry = new Set<string>();

/**
 * Scan all .ts files in the workspace for `.extend()` aliases.
 * Called on activation and when non-test .ts files change.
 */
async function discoverAliases(): Promise<void> {
  const tsFiles = await vscode.workspace.findFiles(
    "**/*.ts",
    "**/node_modules/**",
  );
  const prev = new Set(aliasRegistry);
  aliasRegistry.clear();
  for (const file of tsFiles) {
    try {
      const content = (await vscode.workspace.fs.readFile(file)).toString();
      for (const alias of extractAliasesFromSource(content)) {
        aliasRegistry.add(alias);
      }
    } catch {
      // skip unreadable files
    }
  }

  // If aliases changed, re-parse all test files so they pick up the new names
  if (!setsEqual(prev, aliasRegistry)) {
    await discoverAllTests();
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Get current aliases as array (for passing to parser functions). */
export function getAliases(): string[] | undefined {
  return aliasRegistry.size > 0 ? [...aliasRegistry] : undefined;
}

/** Path to the most recent result.json — used by the "Open Last Result" command. */
let lastResultJsonPath: string | undefined;

/** Last run items — used by the "Re-run Last Request" command. */
let lastRunInclude: readonly vscode.TestItem[] | undefined;
let lastRunWasAll = false;

// TODO: re-enable when https://glubean.com/viewer is live
// let shownWebViewerPrompt = false;

/** Get the path to the most recent result.json file. */
export function getLastResultJsonPath(): string | undefined {
  return lastResultJsonPath;
}

/**
 * After a test run, open the result viewer in a side editor.
 * Always uses the result viewer — trace data is embedded in the result.
 */
async function openPostRunViewer(
  filePath: string,
  resultJsonPath: string,
  _parsed: import("./testController/results").GlubeanResult | null,
  _metaId?: string,
): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(resultJsonPath),
    "glubean.resultViewer",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
  );
}


/**
 * Optional env file provider. When set, returns the selected .env file path
 * (relative to workspace root), or undefined for the default .env.
 */
let envFileProvider: (() => string | undefined) | undefined;

/** Register an env file provider (called by extension.ts to wire up env switcher). */
export function setEnvFileProvider(fn: () => string | undefined): void {
  envFileProvider = fn;
}

// CLI path provider removed — tests are now executed via @glubean/runner directly.

// ---------------------------------------------------------------------------
// Run complete listener
// ---------------------------------------------------------------------------

/** Summary passed to the run complete listener after each run handler finishes. */
export interface RunSummary {
  /** Number of test items in the run request. */
  testCount: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Inferred location of the first test file in the run. */
  location: "explore" | "tests" | "other";
}

let runCompleteListener: ((summary: RunSummary) => void) | undefined;

/** Register a run complete listener (called by extension.ts to wire up telemetry). */
export function setRunCompleteListener(
  fn: (summary: RunSummary) => void,
): void {
  runCompleteListener = fn;
}

/** Classify which directory a file path belongs to. */
function classifyRunLocation(filePaths: string[]): RunSummary["location"] {
  const first = (filePaths[0] ?? "").replace(/\\/g, "/");
  if (first.includes("/explore/")) return "explore";
  if (first.includes("/tests/")) return "tests";
  return "other";
}

/** Read the result history limit from VS Code settings. */
function getResultLimit(): number | undefined {
  const config = vscode.workspace.getConfiguration("glubean");
  return config.get<number>("resultHistoryLimit");
}

/**
 * Run a test.pick example via CodeLens.
 *
 * Uses the Test Controller's TestRun panel (same as gutter play button)
 * so output appears in Test Results with proper ANSI rendering.
 *
 * Uses --filter (prefix match) to scope to the right test.pick export,
 * and --pick to select a specific example key (or omit for random).
 *
 * @param filePath Path to the test file
 * @param testId The test ID template from parser (e.g. "pick:search-products-$_pick")
 * @param pickKey The example key to pass via --pick (undefined = random)
 * @param exportName The JS export name (e.g. "directions") for fallback lookup
 */
export async function runWithPick(
  filePath: string,
  testId: string,
  pickKey?: string,
  exportName?: string,
): Promise<void> {


  const cwd = workspaceRootFor(filePath);
  const filterId = normalizeFilterId(testId);

  // Create a TestRun so output goes to the Test Results panel
  const run = controller.createTestRun(
    new vscode.TestRunRequest(),
    `pick: ${pickKey ?? "random"}`,
    false,
  );

  outputChannel.appendLine(
    `\n▶ run ${filePath} (pick: ${pickKey ?? "random"})`,
  );

  try {
    const parsed = await executeTest(
      filePath,
      [filterId],
      cwd,
      run.token,
      run,
      { envFile: envFileProvider?.(), pick: pickKey, exportName },
    );

    const resultJsonPath = filePath.replace(/\.(ts|js|mjs)$/, ".result.json");
    if (parsed.tests.length > 0) {
      lastResultJsonPath = resultJsonPath;
    }

    writeRunArtifacts(filePath, resultJsonPath, parsed, cwd);
    await openPostRunViewer(filePath, resultJsonPath, parsed, `pick:${testId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`Error: ${message}`);
  } finally {
    run.end();
  }
}

/**
 * Re-run the last executed test(s).
 * Returns false if there's nothing to re-run.
 */
export async function rerunLast(): Promise<boolean> {
  if (!lastRunWasAll && (!lastRunInclude || lastRunInclude.length === 0)) {
    return false;
  }
  const request = lastRunWasAll
    ? new vscode.TestRunRequest()
    : new vscode.TestRunRequest(lastRunInclude);
  const cts = new vscode.CancellationTokenSource();
  try {
    await runHandler(request, cts.token);
  } finally {
    cts.dispose();
  }
  return true;
}

/**
 * Run all tests in a specific file via the Test Controller.
 *
 * Ensures the file is discovered first, then creates a TestRunRequest
 * targeting the file's TestItem so results flow through the Test Results
 * panel with structured output, trace auto-open, and pass/fail icons.
 */
export async function runFileByUri(uri: vscode.Uri): Promise<void> {
  // Ensure the file is parsed so its TestItem exists
  await parseFile(uri);

  const fileItem = fileItems.get(uri.toString());
  if (!fileItem) {
    vscode.window.showWarningMessage(
      "No tests found in this file. Make sure it imports from @glubean/sdk.",
    );
    return;
  }

  const request = new vscode.TestRunRequest([fileItem]);
  const cts = new vscode.CancellationTokenSource();
  try {
    await runHandler(request, cts.token);
  } finally {
    cts.dispose();
  }
}

/**
 * Run all tests in a specific project via the Test Controller.
 *
 * Discovers test files scoped to the given workspace folder, then runs
 * only the tests belonging to that folder. This prevents running unrelated
 * *.test.ts files from other workspace roots in a multi-root setup.
 */
export async function runAll(folder: vscode.WorkspaceFolder): Promise<void> {
  // Discover test files scoped to this folder only (ignores autoDiscover)
  await discoverTestsInFolder(folder);

  // Collect only the file-level TestItems that belong to this folder
  const include: vscode.TestItem[] = [];
  for (const [uriString, item] of fileItems) {
    const itemFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(uriString),
    );
    if (itemFolder && itemFolder.uri.fsPath === folder.uri.fsPath) {
      include.push(item);
    }
  }

  if (include.length === 0) {
    vscode.window.showInformationMessage(
      "No Glubean tests found in this project.",
    );
    return;
  }

  const request = new vscode.TestRunRequest(include);
  const cts = new vscode.CancellationTokenSource();
  try {
    await runHandler(request, cts.token);
  } finally {
    cts.dispose();
  }
}

/**
 * Activate the Glubean Test Controller.
 */
export function activate(context: vscode.ExtensionContext): void {
  controller = vscode.tests.createTestController("glubean", "Glubean Tests");
  context.subscriptions.push(controller);

  outputChannel = vscode.window.createOutputChannel("Glubean Tests");
  context.subscriptions.push(outputChannel);

  // ── Run profile ────────────────────────────────────────────────────────
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    runHandler,
    true, // default profile
  );

  // ── Debug profile ──────────────────────────────────────────────────────
  // Uses --inspect-brk to pause the harness subprocess, then
  // attaches VSCode's debugger so breakpoints in .test.ts work.
  controller.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    debugHandler,
    true, // default debug profile
  );

  // ── Alias discovery (scan for .extend() calls) ─────────────────────────
  // Must run before test discovery so aliases are available for parsing.
  // Fire-and-forget: discoverAliases triggers discoverAllTests when done.
  void discoverAliases();

  // Watch non-test .ts files for .extend() changes (config/fixture files)
  const aliasWatcher = vscode.workspace.createFileSystemWatcher("**/*.ts");
  aliasWatcher.onDidChange((uri) => {
    if (!isGlubeanFileName(uri.fsPath)) void discoverAliases();
  });
  aliasWatcher.onDidCreate((uri) => {
    if (!isGlubeanFileName(uri.fsPath)) void discoverAliases();
  });
  aliasWatcher.onDidDelete((uri) => {
    if (!isGlubeanFileName(uri.fsPath)) void discoverAliases();
  });
  context.subscriptions.push(aliasWatcher);

  // ── File watcher for auto-discovery (*.test.{ts,js,mjs}) ───────────────
  const testWatcher = vscode.workspace.createFileSystemWatcher("**/*.test.{ts,js,mjs}");

  const onFileChange = (uri: vscode.Uri) => debouncedParse(uri);
  const onFileDelete = (uri: vscode.Uri) => {
    const key = uri.toString();
    const item = fileItems.get(key);
    if (item) {
      // Remove from whichever root group it belongs to
      testsRoot?.children.delete(item.id);
      exploreRoot?.children.delete(item.id);
      controller.items.delete(item.id);
      fileItems.delete(key);
    }
  };

  testWatcher.onDidChange(onFileChange);
  testWatcher.onDidCreate(onFileChange);
  testWatcher.onDidDelete(onFileDelete);

  context.subscriptions.push(testWatcher);

  // ── Resolve handler (lazy discovery) ───────────────────────────────────
  controller.resolveHandler = async (item) => {
    if (!item) {
      // Root level: discover all test files in workspace
      await discoverAllTests();
    }
  };

  // ── Parse currently open editors ───────────────────────────────────────
  for (const editor of vscode.window.visibleTextEditors) {
    if (isGlubeanFileName(editor.document.fileName)) {
      void parseFile(editor.document.uri);
    }
  }

  // ── Parse files when opened ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isGlubeanFileName(doc.fileName)) {
        void parseFile(doc.uri);
      }
    }),
  );

  // ── Re-parse on save (debounced) ───────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isGlubeanFileName(doc.fileName)) {
        debouncedParse(doc.uri);
      }
    }),
  );
}

/** Check if a file name is a Glubean test file (*.test.ts, *.test.js, *.test.mjs). */
function isGlubeanFileName(fileName: string): boolean {
  return /\.test\.(ts|js|mjs)$/.test(fileName);
}

// ---------------------------------------------------------------------------
// Debounced parse — coalesce rapid file-change events + per-file mutex
// ---------------------------------------------------------------------------

/** Per-file debounce timers to prevent redundant parseFile() calls. */
const parseTimers = new Map<string, NodeJS.Timeout>();
const PARSE_DEBOUNCE_MS = 150;

/** Per-file mutex: prevents overlapping parseFile() async calls for the same URI. */
const parseLocks = new Map<string, boolean>();
const parseQueued = new Map<string, boolean>();

/**
 * Schedule a debounced parseFile(). Rapid calls for the same URI within
 * PARSE_DEBOUNCE_MS are coalesced into a single parse.
 * A per-file mutex ensures only one parseFile() runs at a time per URI;
 * if a parse is already in progress, the next one is queued.
 */
function debouncedParse(uri: vscode.Uri): void {
  const key = uri.toString();
  const existing = parseTimers.get(key);
  if (existing) clearTimeout(existing);
  parseTimers.set(key, setTimeout(() => {
    parseTimers.delete(key);
    void lockedParse(uri);
  }, PARSE_DEBOUNCE_MS));
}

async function lockedParse(uri: vscode.Uri): Promise<void> {
  const key = uri.toString();

  if (parseLocks.get(key)) {
    // A parse is already running — queue one more (only the latest matters)
    parseQueued.set(key, true);
    return;
  }

  parseLocks.set(key, true);
  try {
    await parseFile(uri);
  } finally {
    parseLocks.delete(key);
    // If another parse was queued while we were running, run it now
    if (parseQueued.get(key)) {
      parseQueued.delete(key);
      void lockedParse(uri);
    }
  }
}

// ---------------------------------------------------------------------------
// Test discovery
// ---------------------------------------------------------------------------

/**
 * Discover all *.test.ts files in the workspace.
 * Respects the autoDiscover setting — used for background discovery.
 */
async function discoverAllTests(): Promise<void> {
  const config = vscode.workspace.getConfiguration("glubean");
  if (!config.get<boolean>("autoDiscover", true)) {
    return;
  }

  const testFiles = await vscode.workspace.findFiles(
    "**/*.test.{ts,js,mjs}",
    "**/node_modules/**",
  );

  for (const file of testFiles) {
    await parseFile(file);
  }
}

/**
 * Discover *.test.ts files scoped to a single workspace folder.
 * Always runs regardless of autoDiscover — used for explicit user actions.
 */
async function discoverTestsInFolder(
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const pattern = new vscode.RelativePattern(folder, "**/*.test.{ts,js,mjs}");
  const testFiles = await vscode.workspace.findFiles(
    pattern,
    "**/node_modules/**",
  );

  for (const file of testFiles) {
    await parseFile(file);
  }
}

/**
 * Parse a single test file and update the Test Controller tree.
 */
async function parseFile(uri: vscode.Uri): Promise<void> {
  let content: string;
  try {
    // Try to read from open editor first (has unsaved changes)
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString(),
    );
    content = doc
      ? doc.getText()
      : (await vscode.workspace.fs.readFile(uri)).toString();
  } catch {
    return;
  }

  const aliases = getAliases();
  const key = uri.toString();

  const tests = extractTests(content, aliases);
  if (tests.length === 0) {
    // No test exports found — clean up any previously discovered items
    // so they don't linger as ghost nodes.
    const existing = fileItems.get(key);
    if (existing) {
      testsRoot?.children.delete(existing.id);
      exploreRoot?.children.delete(existing.id);
      controller.items.delete(existing.id);
      fileItems.delete(key);
    }
    return;
  }

  // Determine grouping by directory: files under explore/ go to Explore group
  const workspaceRoot = workspaceRootFor(uri.fsPath);
  const relPath = path.relative(workspaceRoot, uri.fsPath);
  const isExplore =
    relPath.startsWith("explore/") || relPath.startsWith("explore\\");

  // Create or update file-level TestItem
  const fileName = path.basename(uri.fsPath);
  const fileItem = controller.createTestItem(key, fileName, uri);
  fileItems.set(key, fileItem);

  // Add test children
  for (const test of tests) {
    const testItem = controller.createTestItem(
      `${key}#${test.id}`,
      test.name || test.id,
      uri,
    );

    // Set the range so VS Code shows ▶ in the gutter
    // line is 1-based from parser, VS Code Range is 0-based
    const line = test.line - 1;
    testItem.range = new vscode.Range(line, 0, line, 999);

    // Add step children for builder-style tests
    if (test.steps && test.steps.length > 0) {
      for (let i = 0; i < test.steps.length; i++) {
        const stepItem = controller.createTestItem(
          `${key}#${test.id}#step-${i}`,
          `step: ${test.steps[i]}`,
          uri,
        );
        testItem.children.add(stepItem);
      }
    }

    // Store metadata on the TestItem for use during execution
    testItemMeta.set(testItem, test);

    fileItem.children.add(testItem);
  }

  // Route to the appropriate root group node based on directory
  // Explore is listed first (primary use case in IDE)
  //
  // Tree structure (multi-project):
  //   Explore
  //     └─ cookbook
  //     │    └─ smoke.test.ts
  //     └─ tests
  //          └─ rp2-solution.test.ts
  //   Tests
  //     └─ tests
  //          └─ api/health.test.ts
  //
  // Single project: skip the project layer.

  const folders = vscode.workspace.workspaceFolders ?? [];
  const multiProject = folders.length > 1;
  const folderObj = folders.find((f) => f.uri.fsPath === workspaceRoot);
  const projectName = folderObj?.name ?? path.basename(workspaceRoot);

  if (isExplore) {
    if (!exploreRoot) {
      exploreRoot = controller.createTestItem("glubean-explore", "Explore");
      controller.items.add(exploreRoot);
    }
    if (multiProject) {
      const projectKey = `explore:${workspaceRoot}`;
      let projectNode = projectNodes.get(projectKey);
      if (!projectNode) {
        projectNode = controller.createTestItem(projectKey, projectName);

        projectNodes.set(projectKey, projectNode);
        exploreRoot.children.add(projectNode);
      }
      projectNode.children.add(fileItem);
    } else {
      exploreRoot.children.add(fileItem);
    }
  } else {
    if (!testsRoot) {
      testsRoot = controller.createTestItem("glubean-tests", "Tests");
      controller.items.add(testsRoot);
    }
    if (multiProject) {
      const projectKey = `tests:${workspaceRoot}`;
      let projectNode = projectNodes.get(projectKey);
      if (!projectNode) {
        projectNode = controller.createTestItem(projectKey, projectName);

        projectNodes.set(projectKey, projectNode);
        testsRoot.children.add(projectNode);
      }
      projectNode.children.add(fileItem);
    } else {
      testsRoot.children.add(fileItem);
    }
  }
}

/** Store TestMeta on TestItems for retrieval during run */
const testItemMeta = new WeakMap<vscode.TestItem, TestMeta>();

// ---------------------------------------------------------------------------
// Trace operations (delegated)
// ---------------------------------------------------------------------------

/**
 * Diff the two latest result files for a test file.
 * Delegates the filesystem + editor operations to testController/trace.ts.
 */
export async function diffWithPrevious(filePath?: string): Promise<boolean> {
  return await diffWithPreviousTrace(filePath, resultModuleDeps);
}

// ---------------------------------------------------------------------------
// Copy as cURL
// ---------------------------------------------------------------------------

/**
 * Read the active editor (if it's a .result.json file), extract trace
 * data and copy the first request as a cURL command to the clipboard.
 *
 * Returns false if the active editor is not a result file or parsing fails.
 */
export async function copyAsCurl(): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;

  const filePath = editor.document.fileName;
  if (!filePath.endsWith(".result.json")) return false;

  const text = editor.document.getText();

  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.tests)) return false;

    // Find the first trace event with request data
    for (const test of parsed.tests) {
      if (!Array.isArray(test.events)) continue;
      for (const event of test.events) {
        if (event.type !== "trace" || !event.data) continue;
        const d = event.data as Record<string, unknown>;
        const pair: TracePair = {
          request: {
            method: (d.method as string) || "GET",
            url: (d.url as string) || "",
            headers: d.requestHeaders as Record<string, string> | undefined,
            body: d.requestBody as unknown,
          },
        };
        const curl = tracePairToCurl(pair);
        await vscode.env.clipboard.writeText(curl);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test execution
// ---------------------------------------------------------------------------

/**
 * Run handler — called when user clicks ▶ (single test, file, or all).
 */
async function runHandler(
  request: vscode.TestRunRequest,
  cancellation: vscode.CancellationToken,
): Promise<void> {


  const runStartTime = Date.now();
  const run = controller.createTestRun(request);

  // Show the Test Results panel so the user sees live output immediately
  vscode.commands.executeCommand("testing.showMostRecentOutput");

  // Track last run for re-run command
  lastRunInclude = request.include;
  lastRunWasAll = !request.include;

  // Collect tests to run
  const testsToRun: Array<{
    item: vscode.TestItem;
    meta: TestMeta;
    filePath: string;
  }> = [];

  if (request.include) {
    // Specific tests requested
    for (const item of request.include) {
      collectTests(item, testsToRun);
    }
  } else {
    // Run all
    controller.items.forEach((fileItem) => {
      collectTests(fileItem, testsToRun);
    });
  }

  // Exclude requested items
  const excludeIds = new Set((request.exclude ?? []).map((item) => item.id));
  const filtered = testsToRun.filter((t) => !excludeIds.has(t.item.id));

  // Group by file for efficiency
  const byFile = new Map<string, typeof filtered>();
  for (const t of filtered) {
    const existing = byFile.get(t.filePath) ?? [];
    existing.push(t);
    byFile.set(t.filePath, existing);
  }

  for (const [filePath, tests] of byFile) {
    if (cancellation.isCancellationRequested) {
      break;
    }

    // Mark all tests as started
    for (const { item } of tests) {
      run.started(item);
    }

    // If running all tests in a file, don't filter
    const isWholeFile =
      tests.length ===
      (fileItems.get(vscode.Uri.file(filePath).toString())?.children.size ?? 0);

    if (isWholeFile) {
      await runFile(filePath, tests, run, cancellation);
    } else {
      // Run each test individually with --filter
      for (const test of tests) {
        if (cancellation.isCancellationRequested) {
          break;
        }
        await runSingleTest(filePath, test, run, cancellation);
      }
    }
  }

  run.end();

  if (runCompleteListener && filtered.length > 0) {
    runCompleteListener({
      testCount: filtered.length,
      durationMs: Date.now() - runStartTime,
      location: classifyRunLocation([...byFile.keys()]),
    });
  }

  // TODO: re-enable when https://glubean.com/viewer is live
  // if (lastResultJsonPath && !shownWebViewerPrompt) {
  //   shownWebViewerPrompt = true;
  //   const choice = await vscode.window.showInformationMessage(
  //     "Test run complete. View results on the web?",
  //     "Open Viewer",
  //   );
  //   if (choice === "Open Viewer") {
  //     await vscode.env.openExternal(
  //       vscode.Uri.parse("https://glubean.com/viewer"),
  //     );
  //   }
  // }
}

// ---------------------------------------------------------------------------
// Debug execution
// ---------------------------------------------------------------------------

/** Default inspector port; incremented if busy. */
const DEBUG_PORT_BASE = 9229;

/**
 * Debug handler — called when user clicks the debug button.
 *
 * Strategy:
 * 1. Spawn `glubean run` with GLUBEAN_INSPECT_BRK env var → executor adds
 *    --inspect-brk to the harness subprocess (not the outer CLI).
 * 2. Poll http://127.0.0.1:{port}/json until the V8 Inspector is ready
 *    (more reliable than parsing stderr through multiple process layers).
 * 3. Attach VSCode debugger with continueOnAttach (auto-continue past break).
 * 4. Race: process exit vs debug session end vs safety timeout.
 *    With --inspect-brk, the process may stay alive after test completes
 *    because the inspector keeps it running. When the debug session ends,
 *    we kill the process group and finish the test run.
 */
async function debugHandler(
  request: vscode.TestRunRequest,
  cancellation: vscode.CancellationToken,
): Promise<void> {


  // Collect tests to debug (only the first test — debug one at a time)
  const testsToRun: Array<{
    item: vscode.TestItem;
    meta: TestMeta;
    filePath: string;
  }> = [];

  if (request.include) {
    for (const item of request.include) {
      collectTests(item, testsToRun);
    }
  } else {
    controller.items.forEach((fileItem) => {
      collectTests(fileItem, testsToRun);
    });
  }

  const excludeIds = new Set((request.exclude ?? []).map((item) => item.id));
  const filtered = testsToRun.filter((t) => !excludeIds.has(t.item.id));

  if (filtered.length === 0) {
    return;
  }

  const run = controller.createTestRun(request);

  // Debug the first test only (breakpoint debugging is inherently sequential)
  const { item, meta, filePath } = filtered[0];
  run.started(item);

  const cwd = workspaceRootFor(filePath);

  let port: number;
  try {
    port = await findFreePort(DEBUG_PORT_BASE);
  } catch {
    run.errored(
      item,
      new vscode.TestMessage("Could not find a free port for the debugger"),
    );
    run.end();
    return;
  }

  const filterId = normalizeFilterId(meta.id);

  outputChannel.appendLine(
    `\n[debug] run ${filePath} --filter ${filterId} (debug port ${port})`,
  );
  outputChannel.appendLine(`  cwd: ${cwd}\n`);

  // Use the runner's inspectBrk option — it passes --inspect-brk to the
  // harness subprocess directly (no CLI wrapper needed).
  const ac = new AbortController();
  const cancelDisposable = cancellation.onCancellationRequested(() => ac.abort());

  let debugEndedDisposable: vscode.Disposable | undefined;
  let safetyTimeoutHandle: NodeJS.Timeout | undefined;

  // Run the test in a background task so we can attach the debugger
  const runner = await import("@glubean/runner");
  const { loadProjectEnv } = await import("./envLoader");
  const { vars, secrets } = await loadProjectEnv(cwd, envFileProvider?.());
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");

  const executor = new runner.TestExecutor({
    cwd,
    emitFullTrace: true,
    inspectBrk: port,
  });

  const fileUrl = pathToFileURL(resolve(cwd, filePath)).href;
  const context: import("@glubean/runner").ExecutionContext = { vars, secrets };

  // Start the test execution (it will pause at --inspect-brk)
  const runIterator = executor.run(fileUrl, filterId, context, {
    signal: ac.signal,
  });

  try {
    // Poll the inspector HTTP endpoint
    outputChannel.appendLine(
      `[debug] Polling http://127.0.0.1:${port}/json ...`,
    );
    const wsUrl = await pollInspectorReady(port);
    outputChannel.appendLine(`[debug] Inspector ready: ${wsUrl}`);

    // Attach VSCode debugger
    const debugSessionName = `Glubean Debug: ${meta.name || meta.id}`;
    const debugFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(filePath),
    );
    const debugStarted = await vscode.debug.startDebugging(
      debugFolder ?? vscode.workspace.workspaceFolders?.[0],
      {
        type: "pwa-node",
        request: "attach",
        name: debugSessionName,
        websocketAddress: wsUrl,
        continueOnAttach: true,
        skipFiles: [
          "<node_internals>/**",
          "**/node_modules/**",
          "**/harness.ts",
        ],
      },
    );

    if (!debugStarted) {
      outputChannel.appendLine("[debug] Failed to start debug session");
      run.errored(
        item,
        new vscode.TestMessage(
          "Failed to attach debugger. Is the js-debug extension available?",
        ),
      );
      return;
    }

    outputChannel.appendLine(
      "[debug] Debugger attached, waiting for completion...",
    );

    // Consume events from the runner while debug session is active
    const debugSessionEnded = new Promise<void>((resolve) => {
      debugEndedDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.name === debugSessionName) {
          outputChannel.appendLine("[debug] Debug session terminated");
          resolve();
        }
      });
    });

    const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
    const safetyTimeout = new Promise<void>((resolve) => {
      safetyTimeoutHandle = setTimeout(() => {
        outputChannel.appendLine(
          "[debug] Safety timeout reached (5min), aborting",
        );
        resolve();
      }, SAFETY_TIMEOUT_MS);
    });

    // Collect events while waiting for debug to end
    const events: import("@glubean/runner").ExecutionEvent[] = [];
    const eventCollector = (async () => {
      for await (const event of runIterator) {
        events.push(event);
        // Stream output to Test Results panel
        if (event.type === "log") {
          run.appendOutput(`  ${event.message}\r\n`);
        } else if (event.type === "assertion") {
          run.appendOutput(`  ${event.passed ? "✓" : "✗"} ${event.message}\r\n`);
        }
      }
    })();

    // Wait for any signal
    await Promise.race([eventCollector, debugSessionEnded, safetyTimeout]);

    // Abort if still running
    ac.abort();

    // Build result from collected events
    let success = false;
    let testName = filterId;
    for (const event of events) {
      if (event.type === "start") testName = event.name || filterId;
      if (event.type === "status") success = event.status === "completed";
    }

    const parsed = {
      summary: { total: 1, passed: success ? 1 : 0, failed: success ? 0 : 1, skipped: 0, durationMs: 0 },
      tests: [{ testId: filterId, testName, success, durationMs: 0, events: [] as any[] }],
    };

    applyResults([{ item, meta }], parsed, run);

    const resultJsonPath = filePath.replace(/\.(ts|js|mjs)$/, ".result.json");
    writeRunArtifacts(filePath, resultJsonPath, parsed, cwd);
    await openPostRunViewer(filePath, resultJsonPath, parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.errored(item, new vscode.TestMessage(`Debug error: ${message}`));
    outputChannel.appendLine(`[debug] Error: ${message}`);
  } finally {
    cancelDisposable.dispose();
    debugEndedDisposable?.dispose();
    if (safetyTimeoutHandle) {
      clearTimeout(safetyTimeoutHandle);
    }
    ac.abort(); // ensure cleanup
    run.end();
  }
}

/**
 * Recursively collect leaf test items from a tree node.
 */
function collectTests(
  item: vscode.TestItem,
  out: Array<{ item: vscode.TestItem; meta: TestMeta; filePath: string }>,
): void {
  const meta = testItemMeta.get(item);
  if (meta && item.uri) {
    out.push({ item, meta, filePath: item.uri.fsPath });
  } else {
    // It's a file-level or step-level item — recurse into children
    item.children.forEach((child) => collectTests(child, out));
  }
}


/**
 * Run all tests in a file (no --filter).
 */
async function runFile(
  filePath: string,
  tests: Array<{ item: vscode.TestItem; meta: TestMeta }>,
  run: vscode.TestRun,
  cancellation: vscode.CancellationToken,
): Promise<void> {
  const cwd = workspaceRootFor(filePath);

  outputChannel.appendLine(`\n▶ run ${filePath}`);
  outputChannel.appendLine(`  cwd: ${cwd}\n`);

  if (isScratchMode(filePath)) showScratchModeHint();

  try {
    const parsed = await executeTest(
      filePath,
      undefined, // run all tests in file
      cwd,
      cancellation,
      run,
      { envFile: envFileProvider?.() },
    );

    applyResults(tests, parsed, run);
    const resultJsonPath = filePath.replace(/\.(ts|js|mjs)$/, ".result.json");
    lastResultJsonPath = resultJsonPath;

    writeRunArtifacts(filePath, resultJsonPath, parsed, cwd);
    await openPostRunViewer(filePath, resultJsonPath, parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const { item } of tests) {
      run.errored(item, new vscode.TestMessage(`Execution error: ${message}`));
    }
    outputChannel.appendLine(`Error: ${message}`);
  }
}

/**
 * Run a single test with --filter.
 */
async function runSingleTest(
  filePath: string,
  test: { item: vscode.TestItem; meta: TestMeta },
  run: vscode.TestRun,
  cancellation: vscode.CancellationToken,
): Promise<void> {
  const filterId = normalizeFilterId(test.meta.id);
  const cwd = workspaceRootFor(filePath);

  outputChannel.appendLine(`\n▶ run ${filePath} --filter ${filterId}`);

  if (isScratchMode(filePath)) showScratchModeHint();

  try {
    const parsed = await executeTest(
      filePath,
      [filterId],
      cwd,
      cancellation,
      run,
      { envFile: envFileProvider?.() },
    );

    applyResults([test], parsed, run);
    const resultJsonPath = filePath.replace(/\.(ts|js|mjs)$/, ".result.json");
    lastResultJsonPath = resultJsonPath;

    writeRunArtifacts(filePath, resultJsonPath, parsed, cwd);
    await openPostRunViewer(filePath, resultJsonPath, parsed, test.meta.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.errored(
      test.item,
      new vscode.TestMessage(`Execution error: ${message}`),
    );
    outputChannel.appendLine(`Error: ${message}`);
  }
}

