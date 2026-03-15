/**
 * Test executor that imports @glubean/runner directly (no CLI subprocess).
 *
 * Replaces the old exec.ts which spawned the glubean CLI binary.
 * The runner spawns tsx harness subprocesses internally.
 */

import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadProjectEnv } from "../envLoader";
import type { GlubeanResult } from "./results";
import type { GlubeanEvent } from "../testController.utils";

// ── Lazy ESM import for @glubean/runner ────────────────────────────────────
// Runner is ESM; the VSCode extension builds as CJS.
// We use a cached dynamic import so it resolves once.

let _runnerModule: typeof import("@glubean/runner") | undefined;

async function getRunner(): Promise<typeof import("@glubean/runner")> {
  if (!_runnerModule) {
    _runnerModule = await import("@glubean/runner");
  }
  return _runnerModule;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface ExecuteTestOptions {
  envFile?: string;
  emitFullTrace?: boolean;
  inspectBrk?: number;
  filter?: string;
  pick?: string;
  exportName?: string;
}

/**
 * Execute tests in a file using @glubean/runner directly.
 *
 * Streams events to the TestRun output panel and returns a GlubeanResult
 * compatible with applyResults().
 */
export async function executeTest(
  filePath: string,
  testIds: string[] | undefined,
  cwd: string,
  cancellation: vscode.CancellationToken,
  run: vscode.TestRun,
  options: ExecuteTestOptions = {},
): Promise<GlubeanResult> {
  const runner = await getRunner();

  // DEBUG: trace path resolution
  console.log("[glubean-debug] executeTest called:", { filePath, cwd, testIds, options });
  console.log("[glubean-debug] runner keys:", Object.keys(runner));
  console.log("[glubean-debug] TestExecutor type:", typeof runner.TestExecutor);

  // Build execution context from .env files
  const { vars, secrets } = await loadProjectEnv(cwd, options.envFile);

  // Create executor
  const executor = new runner.TestExecutor({
    cwd,
    emitFullTrace: options.emitFullTrace ?? true,
    inspectBrk: options.inspectBrk,
  });

  // Connect VSCode CancellationToken to AbortController
  const ac = new AbortController();
  const disposable = cancellation.onCancellationRequested(() => ac.abort());

  const fileUrl = pathToFileURL(resolve(cwd, filePath)).href;
  const context: import("@glubean/runner").ExecutionContext = { vars, secrets };

  const testResults: GlubeanResult["tests"] = [];

  try {
    // Determine which test IDs to run
    const idsToRun = testIds ?? (await discoverTestIds(fileUrl));

    for (const testId of idsToRun) {
      if (cancellation.isCancellationRequested) break;

      const startTime = Date.now();
      const events: GlubeanEvent[] = [];
      let success = false;
      let testName = testId;

      for await (const event of executor.run(fileUrl, testId, context, {
        signal: ac.signal,
        exportName: options.exportName,
      })) {
        // Detect missing Node.js and show actionable notification
        if (event.type === "error" && typeof event.message === "string" && event.message.startsWith("NODE_NOT_FOUND:")) {
          vscode.window.showErrorMessage(
            "Node.js 20+ is required to run Glubean tests. Please install Node.js first.",
            "Download Node.js",
          ).then((choice) => {
            if (choice === "Download Node.js") {
              vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
            }
          });
        }

        // Stream formatted output to Test Results panel
        const line = formatEvent(event);
        if (line) {
          run.appendOutput(line.replace(/\n/g, "\r\n") + "\r\n");
        }

        // Collect events for applyResults
        const glubeanEvent = toGlubeanEvent(event);
        if (glubeanEvent) events.push(glubeanEvent);

        // Track test name and success
        if (event.type === "start") {
          testName = event.name || testId;
        }
        if (event.type === "status") {
          success = event.status === "completed";
        }
      }

      testResults.push({
        testId,
        testName,
        success,
        durationMs: Date.now() - startTime,
        events,
      });
    }
  } finally {
    disposable.dispose();
  }

  // Build summary
  const passed = testResults.filter((t) => t.success).length;
  const failed = testResults.filter((t) => !t.success).length;
  const totalDuration = testResults.reduce((sum, t) => sum + t.durationMs, 0);

  return {
    summary: {
      total: testResults.length,
      passed,
      failed,
      skipped: 0,
      durationMs: totalDuration,
    },
    tests: testResults,
  };
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Discover test IDs from a file by dynamically importing it.
 * Falls back to running all if discovery fails.
 */
async function discoverTestIds(fileUrl: string): Promise<string[]> {
  try {
    const runner = await getRunner();
    // resolveModuleTests is exported from @glubean/runner
    if ("resolveModuleTests" in runner) {
      const mod = await import(fileUrl);
      const tests = (runner as any).resolveModuleTests(mod);
      return tests.map((t: any) => t.id || t.testId);
    }
  } catch {
    // Discovery failed, let the harness handle it
  }
  return ["*"];
}

// ── Event Formatting ───────────────────────────────────────────────────────

function formatEvent(event: import("@glubean/runner").ExecutionEvent): string | undefined {
  switch (event.type) {
    case "start":
      return `▶ ${event.name || event.id}`;
    case "log":
      return event.data !== undefined
        ? `  ${event.message}: ${JSON.stringify(event.data)}`
        : `  ${event.message}`;
    case "assertion":
      return event.passed
        ? `  ✓ ${event.message}`
        : `  ✗ ${event.message}${event.expected !== undefined ? ` (expected: ${JSON.stringify(event.expected)}, actual: ${JSON.stringify(event.actual)})` : ""}`;
    case "warning":
      return `  ⚠ ${event.message}`;
    case "error":
      return `  ✗ ERROR: ${event.message}`;
    case "step_start":
      return `  Step ${event.index + 1}/${event.total}: ${event.name}`;
    case "step_end":
      return `  Step ${event.index + 1}: ${event.status} (${event.durationMs}ms)`;
    case "status":
      return event.status === "completed"
        ? `  ✓ passed`
        : `  ✗ ${event.status}${event.error ? `: ${event.error}` : ""}`;
    case "trace":
      return `  → ${event.data?.method || "?"} ${event.data?.url || ""} [${event.data?.status || "?"}]`;
    default:
      return undefined;
  }
}

// ── Event Conversion ───────────────────────────────────────────────────────

/**
 * Convert runner's ExecutionEvent to the GlubeanEvent shape that
 * applyResults() and buildEventsSummary() expect.
 */
function toGlubeanEvent(event: import("@glubean/runner").ExecutionEvent): GlubeanEvent | undefined {
  switch (event.type) {
    case "log":
      return { type: "log", message: event.message, data: event.data, stepIndex: event.stepIndex };
    case "assertion":
      return {
        type: "assertion",
        passed: event.passed,
        message: event.message,
        actual: event.actual,
        expected: event.expected,
        stepIndex: event.stepIndex,
      };
    case "warning":
      return { type: "warning", message: event.message, stepIndex: event.stepIndex };
    case "error":
      return { type: "error", error: event.message };
    case "status":
      return { type: "status", status: event.status, error: event.error };
    case "step_start":
      return {
        type: "step_start",
        index: event.index,
        name: event.name,
        total: event.total,
      };
    case "step_end":
      return {
        type: "step_end",
        index: event.index,
        name: event.name,
        status: event.status,
        durationMs: event.durationMs,
        assertions: event.assertions,
      };
    case "trace":
      return { type: "trace", data: event.data, stepIndex: event.stepIndex } as GlubeanEvent;
    case "schema_validation":
      return { type: "schema_validation", message: event.label, data: event.issues, stepIndex: event.stepIndex } as unknown as GlubeanEvent;
    case "metric":
      return { type: "metric", name: event.name, data: event.value } as unknown as GlubeanEvent;
    case "summary":
      return { type: "summary", data: event.data } as unknown as GlubeanEvent;
    default:
      return undefined;
  }
}
