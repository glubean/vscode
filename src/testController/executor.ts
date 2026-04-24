/**
 * Test executor that imports @glubean/runner directly (no CLI subprocess).
 *
 * Replaces the old exec.ts which spawned the glubean CLI binary.
 * The runner spawns tsx harness subprocesses internally.
 */

import * as vscode from "vscode";
import { pathToFileURL } from "node:url";
import { resolve, relative } from "node:path";
import { loadProjectEnv } from "@glubean/runner";
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

  // Plugin bootstrap: run glubean.setup.ts so plugin-registered protocols
  // (grpc / graphql / custom) are available. Harness subprocess bootstraps
  // itself, but discoverTestIds below does parent-process `import(fileUrl)`
  // which will fail on plugin-protocol contracts without this.
  // Idempotent via loadState cache in @glubean/runner/bootstrap.
  await runner.bootstrap(cwd);

  // Build execution context from .env files
  const { vars, secrets } = await loadProjectEnv(cwd, options.envFile);

  // Create executor with auto-session
  const executor = new runner.TestExecutor({
    cwd,
    emitFullTrace: options.emitFullTrace ?? true,
    inspectBrk: options.inspectBrk,
  }).withSession(cwd);

  // Connect VSCode CancellationToken to AbortController
  const ac = new AbortController();
  const disposable = cancellation.onCancellationRequested(() => ac.abort());

  const fileUrl = pathToFileURL(resolve(cwd, filePath)).href;
  const context: import("@glubean/runner").ExecutionContext = { vars, secrets };

  const testResults: GlubeanResult["tests"] = [];

  // Set GLUBEAN_PICK env var for pick-based test selection.
  // The runner copies process.env into the harness subprocess, so
  // setting it here propagates to the SDK's pick resolution logic.
  const previousPick = process.env["GLUBEAN_PICK"];
  if (options.pick) {
    process.env["GLUBEAN_PICK"] = options.pick;
  } else {
    delete process.env["GLUBEAN_PICK"];
  }

  try {
    // Determine which test IDs to run. When the caller passes
    // `testIds=undefined` together with `exportName`, scope discovery to
    // that export only — otherwise a single data-driven Test Explorer click
    // (or a pinned `runTestByExport`) would batch-run every unrelated test
    // in the same file.
    const idsToRun = testIds ?? (await discoverTestIds(fileUrl, options.exportName));
    const isWildcard = idsToRun.length === 1 && idsToRun[0] === "*";
    // Export-fallback: parent-side discovery failed (or wasn't attempted)
    // but the caller named an exportName. `discoverTestIds` returns `[""]`
    // so we drive a single harness subprocess with `testId="" + exportName`,
    // and the harness emits per-case events attributed by `event.testId`.
    // We split events dynamically so a data-driven export returns one
    // result entry per emitted case (applyResults → matchTestResults
    // pass-2 needs per-case ids to claim results back into the TestItem).
    const isExportFallback =
      idsToRun.length === 1 && idsToRun[0] === "" && !!options.exportName;

    // PM-2d: batch multiple known testIds into ONE subprocess via the
    // `testIds` option. Previous impl spawned one harness per testId, which
    // for a 10-test file = 10 tsx subprocess boots. Keep the wildcard path
    // (discovery fallback) as a single per-testId call because "*" isn't a
    // real id and harness interprets it specially.
    const shouldBatch = !isWildcard && !isExportFallback && idsToRun.length > 1;

    if (shouldBatch) {
      const startTimes = new Map<string, number>();
      const eventsPerTest = new Map<string, GlubeanEvent[]>();
      const namesPerTest = new Map<string, string>();
      for (const id of idsToRun) {
        startTimes.set(id, Date.now());
        eventsPerTest.set(id, []);
        namesPerTest.set(id, id);
      }

      for await (const event of executor.run(fileUrl, "", context, {
        signal: ac.signal,
        exportName: options.exportName,
        testIds: idsToRun,
      })) {
        if (event.type === "error" && typeof event.message === "string" && event.message.startsWith("NODE_NOT_FOUND:")) {
          vscode.window.showErrorMessage(
            "Node.js 20+ is required to run Glubean tests. Install Node.js, then restart VS Code (not just Reload Window).",
            "Download Node.js",
          ).then((choice) => {
            if (choice === "Download Node.js") {
              vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
            }
          });
        }

        const line = formatEvent(event);
        if (line) {
          run.appendOutput(line.replace(/\n/g, "\r\n") + "\r\n");
        }

        const glubeanEvent = toGlubeanEvent(event);
        if (glubeanEvent) {
          if (event.testId && eventsPerTest.has(event.testId)) {
            // Scoped event — attribute to its specific test
            eventsPerTest.get(event.testId)!.push(glubeanEvent);
          } else {
            // Unscoped event — session setup failure, module import error,
            // spawn failure, OOM, test_timeout propagating up, or any fatal
            // that prevented per-test attribution. Broadcast to every
            // selected id so `generateSummary` sees the failure on each and
            // Test Explorer doesn't silently mark un-started tests as passed
            // (generateSummary([]) currently returns success=true, so empty
            // arrays would be false positives).
            for (const id of idsToRun) {
              eventsPerTest.get(id)!.push(glubeanEvent);
            }
          }
        }

        if (event.type === "start" && event.testId && namesPerTest.has(event.testId)) {
          namesPerTest.set(event.testId, event.name || event.testId);
          startTimes.set(event.testId, Date.now());
        }
      }

      const summaryFn = (await getRunner()).generateSummary;
      for (const id of idsToRun) {
        const evs = eventsPerTest.get(id)!;
        const summary = summaryFn(evs as any);
        testResults.push({
          testId: id,
          testName: namesPerTest.get(id) || id,
          success: summary.success,
          durationMs: Date.now() - (startTimes.get(id) || Date.now()),
          events: evs,
        });
      }
    } else if (isExportFallback) {
      // Single harness subprocess scoped by `exportName`. Harness emits
      // per-case events carrying `event.testId`; we split dynamically into
      // one testResults entry per emitted id. Unscoped events (error /
      // file-level failure before any test started) fall into a shared
      // bucket so `generateSummary` still reflects the failure.
      const startedAt = Date.now();
      const eventsPerTest = new Map<string, GlubeanEvent[]>();
      const namesPerTest = new Map<string, string>();
      const startTimesPer = new Map<string, number>();
      const unscopedBucket: GlubeanEvent[] = [];

      for await (const event of executor.run(fileUrl, "", context, {
        signal: ac.signal,
        exportName: options.exportName,
      })) {
        if (event.type === "error" && typeof event.message === "string" && event.message.startsWith("NODE_NOT_FOUND:")) {
          vscode.window.showErrorMessage(
            "Node.js 20+ is required to run Glubean tests. Install Node.js, then restart VS Code (not just Reload Window).",
            "Download Node.js",
          ).then((choice) => {
            if (choice === "Download Node.js") {
              vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
            }
          });
        }

        const line = formatEvent(event);
        if (line) {
          run.appendOutput(line.replace(/\n/g, "\r\n") + "\r\n");
        }

        const glubeanEvent = toGlubeanEvent(event);
        if (!glubeanEvent) continue;

        if (event.testId) {
          if (!eventsPerTest.has(event.testId)) {
            eventsPerTest.set(event.testId, [...unscopedBucket]);
            namesPerTest.set(event.testId, event.testId);
            startTimesPer.set(event.testId, Date.now());
          }
          eventsPerTest.get(event.testId)!.push(glubeanEvent);
          if (event.type === "start") {
            namesPerTest.set(event.testId, event.name || event.testId);
          }
        } else {
          // Broadcast unscoped event to any already-known tests; also keep
          // in a bucket for future-appearing ids.
          unscopedBucket.push(glubeanEvent);
          for (const evs of eventsPerTest.values()) evs.push(glubeanEvent);
        }
      }

      const summaryFn = (await getRunner()).generateSummary;
      if (eventsPerTest.size === 0) {
        // Harness never emitted a scoped testId (e.g. session-setup failed
        // before any case ran). Push a single fallback result keyed by
        // exportName so applyResults still sees something.
        const summary = summaryFn(unscopedBucket as any);
        testResults.push({
          testId: options.exportName || "",
          testName: options.exportName || "",
          success: summary.success,
          durationMs: Date.now() - startedAt,
          events: unscopedBucket,
        });
      } else {
        for (const [id, evs] of eventsPerTest) {
          const summary = summaryFn(evs as any);
          testResults.push({
            testId: id,
            testName: namesPerTest.get(id) || id,
            success: summary.success,
            durationMs: Date.now() - (startTimesPer.get(id) || startedAt),
            events: evs,
          });
        }
      }
    } else {
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
          if (event.type === "error" && typeof event.message === "string" && event.message.startsWith("NODE_NOT_FOUND:")) {
            vscode.window.showErrorMessage(
              "Node.js 20+ is required to run Glubean tests. Install Node.js, then restart VS Code (not just Reload Window).",
              "Download Node.js",
            ).then((choice) => {
              if (choice === "Download Node.js") {
                vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
              }
            });
          }

          const line = formatEvent(event);
          if (line) {
            run.appendOutput(line.replace(/\n/g, "\r\n") + "\r\n");
          }

          const glubeanEvent = toGlubeanEvent(event);
          if (glubeanEvent) events.push(glubeanEvent);

          if (event.type === "start") {
            testName = event.name || testId;
          }
        }

        const testSummary = (await getRunner()).generateSummary(events as any);
        success = testSummary.success;

        testResults.push({
          testId,
          testName,
          success,
          durationMs: Date.now() - startTime,
          events,
        });
      }
    }
  } finally {
    // Session teardown (no-op if no session.ts was discovered)
    for await (const _event of executor.finalize()) {}

    // Restore previous GLUBEAN_PICK value to avoid leaking across runs
    if (previousPick !== undefined) {
      process.env["GLUBEAN_PICK"] = previousPick;
    } else {
      delete process.env["GLUBEAN_PICK"];
    }
    disposable.dispose();
  }

  // Build summary — aggregate all test events through generateSummary
  const allEvents = testResults.flatMap((t) => t.events);
  const { generateSummary } = await getRunner();
  const stats = generateSummary(allEvents as any);
  const passed = testResults.filter((t) => t.success).length;
  const failed = testResults.filter((t) => !t.success).length;
  const totalDuration = testResults.reduce((sum, t) => sum + t.durationMs, 0);

  // Build run context
  let runContext: GlubeanResult["context"];
  try {
    const { buildRunContext } = await getRunner();
    const ext = vscode.extensions.getExtension("Glubean.glubean");
    runContext = {
      ...buildRunContext(),
      command: options.inspectBrk ? "vscode-debug" : "vscode-play",
      cwd,
      ...(options.envFile && { envFile: options.envFile }),
      vscodeVersion: vscode.version,
      ...(ext && { extensionVersion: ext.packageJSON?.version }),
    };
  } catch {
    // Non-critical — old vendored runner may not export buildRunContext
  }

  return {
    ...(runContext && { context: runContext }),
    target: filePath,
    files: [relative(cwd, filePath)],
    summary: {
      total: testResults.length,
      passed,
      failed,
      skipped: 0,
      durationMs: totalDuration,
      stats,
    },
    tests: testResults,
  };
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Discover test IDs from a file by dynamically importing it.
 *
 * When `exportName` is provided, scope the result to just that export's
 * tests — essential for data-driven (`test.each` / `test.pick`) runs where
 * one Test Explorer click should not widen to every unrelated test in the
 * same file. Without this filter, `runSingleTest()` for `each:/pick:`
 * items (passes `testIds=undefined, exportName="X"`) and `runTestByExport()`
 * for pinned data-driven tests would batch-run the whole file.
 *
 * **Fallback semantics when parent-side discovery fails:**
 * - Without `exportName`: `["*"]` — harness runs all tests in the file.
 * - With `exportName`: `[""]` — harness resolves tests by exportName
 *   alone (testId="" tells the runner "no explicit id filter"). Critical:
 *   returning `["*"]` here would widen scope to every test in the file
 *   since the harness processes `*` as "run all" regardless of the
 *   exportName hint.
 */
async function discoverTestIds(
  fileUrl: string,
  exportName?: string,
): Promise<string[]> {
  try {
    const runner = await getRunner();
    // resolveModuleTests is exported from @glubean/runner
    if ("resolveModuleTests" in runner) {
      const mod = await import(fileUrl);
      const tests = (runner as any).resolveModuleTests(mod);
      const filtered = exportName
        ? tests.filter((t: any) => t.exportName === exportName)
        : tests;
      return filtered.map((t: any) => t.id || t.testId);
    }
  } catch {
    // Discovery failed, let the harness handle it
  }
  // With exportName: return [""] so the non-batched path invokes the
  // harness with `testId="" + exportName=X`, which runs only that export.
  // Without exportName: return ["*"] so the harness runs every test.
  return exportName ? [""] : ["*"];
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
    case "error": {
      const tag = event.reason ? ` [${event.reason.toUpperCase()}]` : "";
      return `  ✗ ERROR${tag}: ${event.message}`;
    }
    case "step_start":
      return `  Step ${event.index + 1}/${event.total}: ${event.name}`;
    case "step_end":
      return `  Step ${event.index + 1}: ${event.status} (${event.durationMs}ms)`;
    case "status": {
      if (event.status === "completed") return `  ✓ passed`;
      const tag = event.reason ? ` [${event.reason.toUpperCase()}]` : "";
      return `  ✗ ${event.status}${tag}${event.error ? `: ${event.error}` : ""}`;
    }
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
      return { type: "error", error: event.message, reason: event.reason };
    case "status":
      return { type: "status", status: event.status, error: event.error, reason: event.reason };
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
    case "event":
      return { type: "event", data: event.data, stepIndex: event.stepIndex } as GlubeanEvent;
    case "action":
      return { type: "action", data: event.data, stepIndex: event.stepIndex } as GlubeanEvent;
    case "summary":
      return { type: "summary", data: event.data } as unknown as GlubeanEvent;
    default:
      return undefined;
  }
}
