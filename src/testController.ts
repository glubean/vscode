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
 * Execution: spawns `glubean run <file> --filter <id> --result-json --emit-full-trace`.
 */

import * as vscode from "vscode";
import * as cp from "child_process";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as fs from "fs";
import { extractTests, isGlubeanFile, type TestMeta } from "./parser";
import {
  buildArgs,
  normalizeFilterId,
  matchTestResults,
  formatJson,
  formatHeaders,
  formatTraceEvent,
  buildEventsSummary,
  tracePairToCurl,
  type GlubeanEvent,
  type TracePair,
} from "./testController.utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed result from --result-json output */
interface GlubeanResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    durationMs: number;
    events: GlubeanEvent[];
  }>;
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace folder that contains the given file path.
 * Falls back to the first workspace folder, then to the file's directory.
 */
function workspaceRootFor(filePath: string): string {
  const fileUri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (folder) {
    return folder.uri.fsPath;
  }
  return (
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    path.dirname(filePath)
  );
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

/** Path to the most recent result.json — used by the "Open Last Result" command. */
let lastResultJsonPath: string | undefined;

/** Last run items — used by the "Re-run Last Request" command. */
let lastRunInclude: readonly vscode.TestItem[] | undefined;
let lastRunWasAll = false;

/** Get the path to the most recent result.json file. */
export function getLastResultJsonPath(): string | undefined {
  return lastResultJsonPath;
}

/**
 * Optional pre-run check. When set, this function is called before test execution.
 * If it returns false, the run is aborted (e.g. missing dependencies).
 */
let preRunCheck: (() => Promise<boolean>) | undefined;

/** Register a pre-run check function (called by extension.ts to wire up dep check). */
export function setPreRunCheck(fn: () => Promise<boolean>): void {
  preRunCheck = fn;
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

/**
 * Optional glubean path provider. When set, returns the resolved path to the
 * glubean CLI binary (checking well-known install locations as fallback).
 * Falls back to the config setting if no provider is registered.
 */
let glubeanPathProvider: (() => string) | undefined;

/** Register a glubean path provider (called by extension.ts). */
export function setGlubeanPathProvider(fn: () => string): void {
  glubeanPathProvider = fn;
}

/** Resolve the glubean CLI path using the provider or config fallback. */
function getGlubeanPath(): string {
  if (glubeanPathProvider) {
    return glubeanPathProvider();
  }
  const config = vscode.workspace.getConfiguration("glubean");
  return config.get<string>("glubeanPath", "glubean");
}

/** Read the trace history limit from VS Code settings. */
function getTraceLimit(): number | undefined {
  const config = vscode.workspace.getConfiguration("glubean");
  return config.get<number>("traceHistoryLimit");
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
 */
export async function runWithPick(
  filePath: string,
  testId: string,
  pickKey?: string,
): Promise<void> {
  // Pre-run dependency check
  if (preRunCheck) {
    const ok = await preRunCheck();
    if (!ok) {
      return;
    }
  }

  const glubeanPath = getGlubeanPath();
  const cwd = workspaceRootFor(filePath);

  // Strip "pick:" prefix and template variables to get a stable prefix filter
  // e.g. "pick:search-products-$_pick" → "search-products-"
  let filterId = testId;
  if (filterId.startsWith("pick:")) {
    filterId = filterId.slice(5);
  }
  filterId = filterId.replace(/\$\w+/g, "");

  const args = buildArgs(filePath, filterId, pickKey, envFileProvider?.(), getTraceLimit());

  // Create a TestRun so output goes to the Test Results panel
  const run = controller.createTestRun(
    new vscode.TestRunRequest(),
    `pick: ${pickKey ?? "random"}`,
    false,
  );

  outputChannel.appendLine(
    `\n▶ ${glubeanPath} ${args.join(" ")} (pick: ${pickKey ?? "random"})`,
  );

  try {
    const result = await execGlubean(glubeanPath, args, cwd, run.token, run);

    // Try to read result JSON and show in Test Results
    const resultJsonPath = filePath.replace(/\.ts$/, ".result.json");
    const parsed = readResultJson(resultJsonPath);

    if (parsed) {
      lastResultJsonPath = resultJsonPath;
      run.appendOutput(`\r\n📄 Result JSON: ${resultJsonPath}\r\n`);
      run.appendOutput(
        `🌐 Open https://glubean.com/viewer to visualize it\r\n`,
      );
    }

    // Open the latest trace file
    await openLatestTrace(filePath);

    if (result.stdout) {
      outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
      outputChannel.appendLine(result.stderr);
    }
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
  await runHandler(request, cts.token);
  cts.dispose();
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
  // Uses --inspect-brk to pause the Deno harness subprocess, then
  // attaches VSCode's Deno debug adapter so breakpoints in .test.ts work.
  controller.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    debugHandler,
    true, // default debug profile
  );

  // ── File watcher for auto-discovery (*.test.ts only) ────────────────────
  const testWatcher = vscode.workspace.createFileSystemWatcher("**/*.test.ts");

  const onFileChange = (uri: vscode.Uri) => parseFile(uri);
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
      parseFile(editor.document.uri);
    }
  }

  // ── Parse files when opened ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isGlubeanFileName(doc.fileName)) {
        parseFile(doc.uri);
      }
    }),
  );

  // ── Re-parse on save ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isGlubeanFileName(doc.fileName)) {
        parseFile(doc.uri);
      }
    }),
  );
}

/** Check if a file name is a Glubean test file (*.test.ts). */
function isGlubeanFileName(fileName: string): boolean {
  return fileName.endsWith(".test.ts");
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
    "**/*.test.ts",
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
  const pattern = new vscode.RelativePattern(folder, "**/*.test.ts");
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

  if (!isGlubeanFile(content)) {
    // Remove previously discovered items for this file if it's no longer a glubean file
    const key = uri.toString();
    const existing = fileItems.get(key);
    if (existing) {
      // Remove from whichever root it belongs to
      testsRoot?.children.delete(existing.id);
      exploreRoot?.children.delete(existing.id);
      controller.items.delete(existing.id);
      fileItems.delete(key);
    }
    return;
  }

  const key = uri.toString();

  const tests = extractTests(content);
  if (tests.length === 0) {
    // File still imports SDK but has no test exports — clean up any
    // previously discovered items so they don't linger as ghost nodes.
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
  if (isExplore) {
    if (!exploreRoot) {
      exploreRoot = controller.createTestItem("glubean-explore", "Explore");
      controller.items.add(exploreRoot);
    }
    exploreRoot.children.add(fileItem);
  } else {
    if (!testsRoot) {
      testsRoot = controller.createTestItem("glubean-tests", "Tests");
      controller.items.add(testsRoot);
    }
    testsRoot.children.add(fileItem);
  }
}

/** Store TestMeta on TestItems for retrieval during run */
const testItemMeta = new WeakMap<vscode.TestItem, TestMeta>();

// ---------------------------------------------------------------------------
// Trace file viewer
// ---------------------------------------------------------------------------

/**
 * Find and open the latest .trace.jsonc file for a given test file.
 *
 * Traces live at `.glubean/traces/{fileName}/{testId}/{timestamp}.trace.jsonc`.
 * When `testId` is provided, looks in that specific subdirectory.
 * When omitted (e.g. "run all" or pick/CodeLens without a known ID),
 * scans all test subdirectories and opens the globally newest trace.
 */
async function openLatestTrace(
  filePath: string,
  testId?: string,
): Promise<void> {
  const cwd = workspaceRootFor(filePath);

  const baseName = path.basename(filePath).replace(/\.ts$/, "");
  const fileTracesDir = path.join(cwd, ".glubean", "traces", baseName);

  try {
    let latestPath: string | undefined;

    if (testId) {
      // Look in the specific test subdirectory
      const testDir = path.join(fileTracesDir, testId);
      const entries = fs
        .readdirSync(testDir)
        .filter((f) => f.endsWith(".trace.jsonc"));
      if (entries.length === 0) return;
      entries.sort().reverse();
      latestPath = path.join(testDir, entries[0]);
    } else {
      // Scan all test subdirectories for the newest trace
      const subdirs = fs
        .readdirSync(fileTracesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      let newest: { file: string; dir: string } | undefined;
      for (const sub of subdirs) {
        const subPath = path.join(fileTracesDir, sub.name);
        const traces = fs
          .readdirSync(subPath)
          .filter((f) => f.endsWith(".trace.jsonc"));
        if (traces.length === 0) continue;
        traces.sort().reverse();
        if (!newest || traces[0] > newest.file) {
          newest = { file: traces[0], dir: subPath };
        }
      }
      if (!newest) return;
      latestPath = path.join(newest.dir, newest.file);
    }

    if (!latestPath) return;

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(latestPath),
    );
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true, // keep focus on the test file
    });
  } catch {
    // Trace dir doesn't exist yet or read failed — silently skip
  }
}

/**
 * Open a VSCode diff view comparing the two most recent trace files
 * for the given test file. If called without a filePath,
 * tries to infer from the active editor or last run.
 */
export async function diffWithPrevious(filePath?: string): Promise<boolean> {
  // Resolve file path from argument, active editor, or last run
  const resolved =
    filePath ?? vscode.window.activeTextEditor?.document.fileName;

  if (!resolved) {
    return false;
  }

  const cwd = workspaceRootFor(resolved);

  const baseName = path
    .basename(resolved)
    .replace(/\.ts$/, "")
    .replace(/\.trace\.jsonc$/, ""); // allow calling from an open trace file

  const fileTracesDir = path.join(cwd, ".glubean", "traces", baseName);

  try {
    // If the resolved file is itself a trace file, its parent dir is the
    // per-test trace directory — diff within that directory.
    if (resolved.endsWith(".trace.jsonc")) {
      const traceDir = path.dirname(resolved);
      return await diffInDir(traceDir, baseName);
    }

    // Otherwise scan all test subdirectories and collect every trace with
    // its full path, then pick the two newest globally.
    const subdirs = fs
      .readdirSync(fileTracesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const allTraces: { name: string; fullPath: string }[] = [];
    for (const sub of subdirs) {
      const subPath = path.join(fileTracesDir, sub.name);
      const traces = fs
        .readdirSync(subPath)
        .filter((f) => f.endsWith(".trace.jsonc"));
      for (const t of traces) {
        allTraces.push({ name: t, fullPath: path.join(subPath, t) });
      }
    }

    if (allTraces.length < 2) {
      return false;
    }

    allTraces.sort((a, b) => b.name.localeCompare(a.name));
    const newestUri = vscode.Uri.file(allTraces[0].fullPath);
    const previousUri = vscode.Uri.file(allTraces[1].fullPath);

    await vscode.commands.executeCommand(
      "vscode.diff",
      previousUri,
      newestUri,
      `${baseName}: previous ↔ latest`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Diff the two most recent traces within a single directory.
 */
async function diffInDir(dir: string, label: string): Promise<boolean> {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".trace.jsonc"));
  if (entries.length < 2) return false;

  entries.sort().reverse();
  const newestUri = vscode.Uri.file(path.join(dir, entries[0]));
  const previousUri = vscode.Uri.file(path.join(dir, entries[1]));

  await vscode.commands.executeCommand(
    "vscode.diff",
    previousUri,
    newestUri,
    `${label}: previous ↔ latest`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Copy as cURL
// ---------------------------------------------------------------------------

/**
 * Read the active editor (if it's a .trace.jsonc file), parse the
 * requests, and copy them as cURL commands to the clipboard.
 *
 * If the trace contains multiple requests, all are joined with newlines.
 * Returns false if the active editor is not a trace file or parsing fails.
 */
export async function copyAsCurl(): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;

  const filePath = editor.document.fileName;
  if (!filePath.endsWith(".trace.jsonc")) return false;

  const text = editor.document.getText();

  // Strip JSONC comment lines (lines starting with //)
  const jsonText = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  let pairs: TracePair[];
  try {
    const parsed = JSON.parse(jsonText);
    pairs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return false;
  }

  const curlCommands = pairs.map(tracePairToCurl);
  const result = curlCommands.join("\n\n");
  await vscode.env.clipboard.writeText(result);
  return true;
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
  // Pre-run dependency check
  if (preRunCheck) {
    const ok = await preRunCheck();
    if (!ok) {
      return;
    }
  }

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

  // Show "View on Web" notification if result JSON was produced
  if (lastResultJsonPath) {
    vscode.window
      .showInformationMessage(
        "Test run complete. View results on the web?",
        "Open Viewer",
      )
      .then((choice) => {
        if (choice === "Open Viewer") {
          vscode.env.openExternal(
            vscode.Uri.parse("https://glubean.com/viewer"),
          );
        }
      });
  }
}

// ---------------------------------------------------------------------------
// Debug execution
// ---------------------------------------------------------------------------

/** Default inspector port; incremented if busy. */
const DEBUG_PORT_BASE = 9229;

/**
 * Find a free TCP port starting from `base`.
 * Tries up to 20 consecutive ports before giving up.
 */
function findFreePort(base: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function tryPort(port: number) {
      const server = net.createServer();
      server.once("error", () => {
        attempts++;
        if (attempts > 20) {
          reject(new Error("Could not find a free port for debugger"));
        } else {
          tryPort(port + 1);
        }
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "127.0.0.1");
    }

    tryPort(base);
  });
}

/**
 * Poll the V8 Inspector HTTP endpoint until it responds.
 * Returns the WebSocket debugger URL from the /json response.
 *
 * This is more reliable than parsing stderr because stderr output can get
 * lost or buffered when the process tree involves shell wrappers and
 * multiple layers of subprocess inheritance.
 */
function pollInspectorReady(port: number, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let done = false;

    function attempt() {
      if (done) return;
      if (Date.now() - startTime > timeoutMs) {
        done = true;
        reject(
          new Error(
            `Timed out waiting for V8 Inspector on port ${port} (${timeoutMs}ms)`,
          ),
        );
        return;
      }

      const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (done) return;
          try {
            const targets = JSON.parse(data);
            if (Array.isArray(targets) && targets.length > 0) {
              const wsUrl = targets[0].webSocketDebuggerUrl;
              if (wsUrl) {
                done = true;
                resolve(wsUrl);
                return;
              }
            }
          } catch {
            // JSON parse failed, retry
          }
          // Got a response but no valid target yet, retry
          setTimeout(attempt, 200);
        });
      });
      req.on("error", () => {
        // Connection refused — inspector not ready yet, retry
        if (!done) {
          setTimeout(attempt, 200);
        }
      });
      req.end();
    }

    attempt();
  });
}

/**
 * Kill an entire process group (detached process).
 * Falls back to killing just the process if group kill fails.
 */
function killProcessGroup(proc: cp.ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;

  try {
    // Kill the entire process group (negative PID)
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: kill just the process
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }

  // Force kill after 2s grace period
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 2000);
}

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
  // Pre-run dependency check
  if (preRunCheck) {
    const ok = await preRunCheck();
    if (!ok) {
      return;
    }
  }

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

  const glubeanPath = getGlubeanPath();
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

  // Build args (no --inspect-brk here — it's passed via env var to the inner harness)
  // Normalize the filter ID so data-driven tests (each:/pick:) resolve correctly.
  const args = buildArgs(filePath, normalizeFilterId(meta.id), undefined, envFileProvider?.(), getTraceLimit());

  outputChannel.appendLine(
    `\n[debug] ${glubeanPath} ${args.join(" ")} (debug port ${port})`,
  );
  outputChannel.appendLine(`  cwd: ${cwd}\n`);

  // Spawn the CLI process as a detached process group so we can kill
  // the entire tree (CLI + harness) reliably.
  // No shell: true — args array is passed directly to the binary, avoiding
  // any shell interpolation of paths with spaces or special characters.
  const proc = cp.spawn(glubeanPath, args, {
    cwd,
    detached: true, // create new process group for reliable cleanup
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      GLUBEAN_INSPECT_BRK: String(port),
    },
  });

  // Don't let the detached process keep the extension host alive
  proc.unref();

  // Handle cancellation
  const cancelDisposable = cancellation.onCancellationRequested(() => {
    killProcessGroup(proc);
  });

  // Capture stdout for test results panel
  proc.stdout?.on("data", (data: Buffer) => {
    run.appendOutput(data.toString().replace(/\n/g, "\r\n"));
  });

  // Log stderr for debugging
  proc.stderr?.on("data", (data: Buffer) => {
    outputChannel.appendLine(`[stderr] ${data.toString().trimEnd()}`);
  });

  // Track process exit (may never fire if inspector keeps process alive)
  const processExited = new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
  });

  try {
    // Poll the inspector HTTP endpoint instead of parsing stderr.
    // This works reliably even when stderr is inherited/buffered across
    // multiple process layers (shell → node shim → deno CLI → deno harness).
    outputChannel.appendLine(
      `[debug] Polling http://127.0.0.1:${port}/json ...`,
    );
    const wsUrl = await pollInspectorReady(port);
    outputChannel.appendLine(`[debug] Inspector ready: ${wsUrl}`);

    // Attach VSCode debugger with continueOnAttach so it auto-continues
    // past the --inspect-brk pause point.
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
      killProcessGroup(proc);
      run.end();
      cancelDisposable.dispose();
      return;
    }

    outputChannel.appendLine(
      "[debug] Debugger attached, waiting for completion...",
    );

    // With --inspect-brk, the process may stay alive after the test finishes
    // because the V8 inspector keeps it running. We race three signals:
    // 1. Process exits naturally (unlikely with --inspect-brk)
    // 2. Debug session ends (user stops, debugger disconnects, etc.)
    // 3. Safety timeout (5 min)
    const debugSessionEnded = new Promise<void>((resolve) => {
      const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.name === debugSessionName) {
          disposable.dispose();
          outputChannel.appendLine("[debug] Debug session terminated");
          resolve();
        }
      });
    });

    const SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
    const safetyTimeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        outputChannel.appendLine(
          "[debug] Safety timeout reached (5min), killing process",
        );
        resolve();
      }, SAFETY_TIMEOUT_MS);
    });

    // Wait for any of the three signals
    await Promise.race([processExited, debugSessionEnded, safetyTimeout]);

    // Kill the process group — the harness may still be alive due to inspector
    killProcessGroup(proc);

    // Give processes a moment to die before reading results
    await new Promise((r) => setTimeout(r, 500));

    // Try to read result JSON
    const resultJsonPath = filePath.replace(/\.ts$/, ".result.json");
    const parsed = readResultJson(resultJsonPath);

    if (parsed) {
      applyResults([{ item, meta }], parsed, run);
      lastResultJsonPath = resultJsonPath;
    } else {
      // No result JSON — use exit code if process already exited
      run.passed(item); // Assume pass if we got here without error
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.errored(item, new vscode.TestMessage(`Debug error: ${message}`));
    outputChannel.appendLine(`[debug] Error: ${message}`);
    killProcessGroup(proc);
  } finally {
    cancelDisposable.dispose();
    killProcessGroup(proc);
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

// buildArgs is imported from ./testController.utils

/**
 * Run all tests in a file (no --filter).
 */
async function runFile(
  filePath: string,
  tests: Array<{ item: vscode.TestItem; meta: TestMeta }>,
  run: vscode.TestRun,
  cancellation: vscode.CancellationToken,
): Promise<void> {
  const glubeanPath = getGlubeanPath();

  const args = buildArgs(filePath, undefined, undefined, envFileProvider?.(), getTraceLimit());
  const cwd = workspaceRootFor(filePath);

  outputChannel.appendLine(`\n▶ ${glubeanPath} ${args.join(" ")}`);
  outputChannel.appendLine(`  cwd: ${cwd}\n`);

  try {
    const result = await execGlubean(glubeanPath, args, cwd, cancellation, run);

    // Try to read result JSON
    const resultJsonPath = filePath.replace(/\.ts$/, ".result.json");
    const parsed = readResultJson(resultJsonPath);

    if (parsed) {
      applyResults(tests, parsed, run);
      lastResultJsonPath = resultJsonPath;
      run.appendOutput(`\r\n📄 Result JSON: ${resultJsonPath}\r\n`);
      run.appendOutput(
        `🌐 Open https://glubean.com/viewer to visualize it\r\n`,
      );
    } else {
      // Fallback to exit code
      for (const { item } of tests) {
        if (result.exitCode === 0) {
          run.passed(item);
        } else {
          run.failed(
            item,
            new vscode.TestMessage(
              result.stderr || "Test failed (no result details available)",
            ),
          );
        }
      }
    }

    // Open the latest trace file in a side editor
    await openLatestTrace(filePath);

    // Also log to Output Channel for persistent reference
    if (result.stdout) {
      outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
      outputChannel.appendLine(result.stderr);
    }
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
  const glubeanPath = getGlubeanPath();

  // For data-driven tests (each: / pick:), the parser ID is a synthetic
  // template like "pick:search-products-$_pick" or "each:user-crud-$name".
  // The runtime test IDs are e.g. "search-products-by-name".
  // normalizeFilterId strips the prefix and template variables to get a
  // substring filter that matches all expanded variants.
  const filterId = normalizeFilterId(test.meta.id);
  const args = buildArgs(filePath, filterId, undefined, envFileProvider?.(), getTraceLimit());
  const cwd = workspaceRootFor(filePath);

  outputChannel.appendLine(`\n▶ ${glubeanPath} ${args.join(" ")}`);

  try {
    const result = await execGlubean(glubeanPath, args, cwd, cancellation, run);

    // Try to read result JSON
    const resultJsonPath = filePath.replace(/\.ts$/, ".result.json");
    const parsed = readResultJson(resultJsonPath);

    if (parsed) {
      applyResults([test], parsed, run);
      lastResultJsonPath = resultJsonPath;
      run.appendOutput(`\r\n📄 Result JSON: ${resultJsonPath}\r\n`);
      run.appendOutput(
        `🌐 Open https://glubean.com/viewer to visualize it\r\n`,
      );
    } else {
      if (result.exitCode === 0) {
        run.passed(test.item);
      } else {
        run.failed(
          test.item,
          new vscode.TestMessage(result.stderr || "Test failed"),
        );
      }
    }

    // Open the latest trace file in a side editor.
    // For plain tests pass the exact ID; for data-driven tests scan all subdirs
    // since the concrete variant ID is only known at runtime.
    const isDataDriven =
      test.meta.id.startsWith("each:") || test.meta.id.startsWith("pick:");
    await openLatestTrace(filePath, isDataDriven ? undefined : test.meta.id);

    if (result.stdout) {
      outputChannel.appendLine(result.stdout);
    }
    if (result.stderr) {
      outputChannel.appendLine(result.stderr);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.errored(
      test.item,
      new vscode.TestMessage(`Execution error: ${message}`),
    );
    outputChannel.appendLine(`Error: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse a .result.json file.
 */
function readResultJson(filePath: string): GlubeanResult | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as GlubeanResult;
  } catch {
    return null;
  }
}

// formatJson, formatHeaders, formatTraceEvent, buildEventsSummary
// are imported from ./testController.utils

/**
 * Create a TestMessage with an optional source location attached.
 * Reduces boilerplate when building failure messages with navigation.
 */
function messageWithLocation(
  content: string | vscode.MarkdownString,
  location?: vscode.Location,
): vscode.TestMessage {
  const msg = new vscode.TestMessage(content);
  if (location) {
    msg.location = location;
  }
  return msg;
}

/**
 * Apply structured test results to TestRun items, including rich event details.
 */
function applyResults(
  tests: Array<{ item: vscode.TestItem; meta: TestMeta }>,
  result: GlubeanResult,
  run: vscode.TestRun,
): void {
  const allMatched = matchTestResults(
    tests.map((t) => t.meta.id),
    result.tests,
  );

  for (let i = 0; i < tests.length; i++) {
    const { item } = tests[i];
    const matchedResults = allMatched[i];

    if (matchedResults.length === 0) {
      run.skipped(item);
      continue;
    }

    // Aggregate events and status across all matched results
    const allEvents = matchedResults.flatMap((r) => r.events);
    const allPassed = matchedResults.every((r) => r.success);
    const totalDuration = matchedResults.reduce(
      (s, r) => s + (r.durationMs ?? 0),
      0,
    );
    const displayName = matchedResults
      .map((r) => r.testName)
      .join(", ");

    // Build rich event summary for TestMessage
    const eventsSummary = buildEventsSummary(allEvents);

    if (allPassed) {
      run.passed(item, totalDuration);
      // Even for passing tests, output logs/traces to TestRun output
      if (eventsSummary) {
        run.appendOutput(
          `\n── ${displayName} ──\r\n${eventsSummary.replace(
            /\n/g,
            "\r\n",
          )}\r\n`,
          undefined,
          item,
        );
      }
    } else {
      // Every failure message gets a location so clicking navigates to source.
      const loc =
        item.uri && item.range
          ? new vscode.Location(item.uri, item.range)
          : undefined;
      const messages: vscode.TestMessage[] = [];

      for (const event of allEvents) {
        if (event.type === "assertion" && event.passed === false) {
          const msg = messageWithLocation(
            event.message ?? "Assertion failed",
            loc,
          );
          if (event.expected !== undefined) {
            msg.expectedOutput = JSON.stringify(event.expected);
          }
          if (event.actual !== undefined) {
            msg.actualOutput = JSON.stringify(event.actual);
          }
          messages.push(msg);
        }

        if (event.type === "error" || event.type === "status") {
          if (event.error) {
            messages.push(messageWithLocation(event.error, loc));
          }
        }
      }

      if (messages.length === 0) {
        messages.push(messageWithLocation("Test failed", loc));
      }

      // Append the full event summary (with HTTP traces) as an additional message
      if (eventsSummary) {
        messages.push(
          messageWithLocation(
            new vscode.MarkdownString("```\n" + eventsSummary + "\n```"),
            loc,
          ),
        );
      }

      run.failed(item, messages, totalDuration);
    }

    // Update step children if present — attach per-step output.
    // For data-driven tests use the first matched result for step mapping
    // (each variant shares the same step structure).
    const primaryResult = matchedResults[0];
    item.children.forEach((stepItem) => {
      const stepIndex = parseInt(stepItem.id.split("#step-")[1] ?? "-1");
      if (stepIndex < 0) return;

      // Find the step_end event for status/duration
      const stepEnd = primaryResult.events.find(
        (e) =>
          e.type === "step_end" &&
          (e as unknown as Record<string, unknown>).index === stepIndex,
      );

      // Collect events belonging to this step.
      // Events between step_start and step_end use the `index` field.
      // Some events (like trace, metric) use `stepIndex` instead.
      const stepEvents: GlubeanEvent[] = [];
      let inStep = false;
      for (const e of primaryResult.events) {
        const ev = e as unknown as Record<string, unknown>;
        if (e.type === "step_start" && ev.index === stepIndex) {
          inStep = true;
          continue;
        }
        if (e.type === "step_end" && ev.index === stepIndex) {
          break;
        }
        if (inStep) {
          stepEvents.push(e);
        } else if (ev.stepIndex === stepIndex) {
          // Catch events tagged with stepIndex but outside start/end markers
          stepEvents.push(e);
        }
      }

      // Build and attach per-step output
      const stepSummary = buildEventsSummary(stepEvents);
      if (stepSummary) {
        run.appendOutput(
          `${stepSummary.replace(/\n/g, "\r\n")}\r\n`,
          undefined,
          stepItem,
        );
      }

      if (stepEnd) {
        const ev = stepEnd as unknown as Record<string, unknown>;
        const status = ev.status;
        const duration = ev.durationMs as number | undefined;
        if (status === "passed") {
          run.passed(stepItem, duration);
        } else if (status === "failed") {
          // Use the parent test item's location so clicking navigates to source
          const loc =
            item.uri && item.range
              ? new vscode.Location(item.uri, item.range)
              : undefined;
          const failMessages: vscode.TestMessage[] = [];

          // Include the step_end error message (e.g. "Request failed with status 429")
          if (ev.error && typeof ev.error === "string") {
            failMessages.push(messageWithLocation(ev.error, loc));
          }

          // Include assertion failures from this step
          for (const se of stepEvents) {
            if (se.type === "assertion" && se.passed === false) {
              failMessages.push(
                messageWithLocation(se.message ?? "Assertion failed", loc),
              );
            }
            if (se.type === "error") {
              failMessages.push(
                messageWithLocation(se.message ?? "Error", loc),
              );
            }
          }

          if (failMessages.length === 0) {
            failMessages.push(messageWithLocation("Step failed", loc));
          }

          // Append the full event summary (HTTP traces, logs) for this step
          if (stepSummary) {
            failMessages.push(
              messageWithLocation(
                new vscode.MarkdownString("```\n" + stepSummary + "\n```"),
                loc,
              ),
            );
          }

          run.failed(stepItem, failMessages, duration);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Execute glubean CLI as a child process.
 */
/**
 * Spawn `glubean` CLI and capture output.
 * When a TestRun is provided, stdout/stderr lines are streamed into it
 * so the Test Results panel shows live output (logs, HTTP traces, etc.).
 *
 * Note: `run.appendOutput()` requires `\r\n` line endings for proper display.
 */
function execGlubean(
  command: string,
  args: string[],
  cwd: string,
  cancellation: vscode.CancellationToken,
  run?: vscode.TestRun,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // No shell: true — args array is passed directly to the binary, avoiding
    // any shell interpolation of paths with spaces or special characters.
    const proc = cp.spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1" }, // keep ANSI colors for pretty output
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (run) {
        // TestRun.appendOutput requires \r\n line endings
        run.appendOutput(text.replace(/\n/g, "\r\n"));
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (run) {
        run.appendOutput(text.replace(/\n/g, "\r\n"));
      }
    });

    const disposable = cancellation.onCancellationRequested(() => {
      proc.kill("SIGTERM");
    });

    proc.on("error", (err) => {
      disposable.dispose();
      reject(err);
    });

    proc.on("close", (code) => {
      disposable.dispose();
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
