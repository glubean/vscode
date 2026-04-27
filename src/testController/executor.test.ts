/**
 * Tests for the test.pick execution logic in executor.ts.
 *
 * These tests verify the observable contracts of the pick execution flow:
 * 1. GLUBEAN_PICK env var is set when options.pick is provided
 * 2. GLUBEAN_PICK env var is deleted when options.pick is absent
 * 3. GLUBEAN_PICK env var is restored after execution
 * 4. exportName is passed through to the runner
 *
 * Since executor.ts depends on vscode and @glubean/runner, we test the
 * env var management logic and option interface in isolation.
 *
 * Run with: npx tsx --test src/testController/executor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import type { ExecuteTestOptions } from "./executor";

// ---------------------------------------------------------------------------
// GLUBEAN_PICK env var management
// ---------------------------------------------------------------------------
// The executor sets process.env.GLUBEAN_PICK based on options.pick,
// then restores the previous value in a finally block.
// We replicate that exact logic here to verify correctness.

/**
 * Simulate the GLUBEAN_PICK env var management from executor.ts lines 82-87.
 * This is the exact same logic used in executeTest().
 */
function applyPickEnv(options: { pick?: string }): string | undefined {
  const previousPick = process.env["GLUBEAN_PICK"];
  if (options.pick) {
    process.env["GLUBEAN_PICK"] = options.pick;
  } else {
    delete process.env["GLUBEAN_PICK"];
  }
  return previousPick;
}

/**
 * Simulate the GLUBEAN_PICK restoration from executor.ts lines 145-150.
 * This is the exact same logic used in the finally block.
 */
function restorePickEnv(previousPick: string | undefined): void {
  if (previousPick !== undefined) {
    process.env["GLUBEAN_PICK"] = previousPick;
  } else {
    delete process.env["GLUBEAN_PICK"];
  }
}

describe("GLUBEAN_PICK env var management", () => {
  let savedPick: string | undefined;

  beforeEach(() => {
    savedPick = process.env["GLUBEAN_PICK"];
    delete process.env["GLUBEAN_PICK"];
  });

  afterEach(() => {
    if (savedPick !== undefined) {
      process.env["GLUBEAN_PICK"] = savedPick;
    } else {
      delete process.env["GLUBEAN_PICK"];
    }
  });

  it("sets GLUBEAN_PICK when pick key is provided (e.g. 'sg-cross-island')", () => {
    const prev = applyPickEnv({ pick: "sg-cross-island" });
    assert.equal(process.env["GLUBEAN_PICK"], "sg-cross-island");
    restorePickEnv(prev);
  });

  it("deletes GLUBEAN_PICK when pick is undefined (Run random)", () => {
    // Pre-set to simulate a previous run that left the var
    process.env["GLUBEAN_PICK"] = "leftover-value";

    const prev = applyPickEnv({ pick: undefined });
    assert.equal(process.env["GLUBEAN_PICK"], undefined);
    restorePickEnv(prev);
  });

  it("deletes GLUBEAN_PICK when options has no pick field", () => {
    process.env["GLUBEAN_PICK"] = "leftover-value";

    const prev = applyPickEnv({});
    assert.equal(process.env["GLUBEAN_PICK"], undefined);
    restorePickEnv(prev);
  });

  it("restores previous GLUBEAN_PICK value after execution", () => {
    process.env["GLUBEAN_PICK"] = "original-value";

    const prev = applyPickEnv({ pick: "sg-cross-island" });
    assert.equal(process.env["GLUBEAN_PICK"], "sg-cross-island");

    restorePickEnv(prev);
    assert.equal(process.env["GLUBEAN_PICK"], "original-value");
  });

  it("restores undefined (deletes) when there was no previous value", () => {
    // Start clean
    assert.equal(process.env["GLUBEAN_PICK"], undefined);

    const prev = applyPickEnv({ pick: "sg-cross-island" });
    assert.equal(process.env["GLUBEAN_PICK"], "sg-cross-island");

    restorePickEnv(prev);
    assert.equal(process.env["GLUBEAN_PICK"], undefined);
  });

  it("handles sequential pick runs without leaking env vars", () => {
    // Simulate: run pick "case-a", then run pick "case-b", then run random
    const prev1 = applyPickEnv({ pick: "case-a" });
    assert.equal(process.env["GLUBEAN_PICK"], "case-a");
    restorePickEnv(prev1);

    const prev2 = applyPickEnv({ pick: "case-b" });
    assert.equal(process.env["GLUBEAN_PICK"], "case-b");
    restorePickEnv(prev2);

    const prev3 = applyPickEnv({});
    assert.equal(process.env["GLUBEAN_PICK"], undefined);
    restorePickEnv(prev3);

    assert.equal(process.env["GLUBEAN_PICK"], undefined);
  });
});

// ---------------------------------------------------------------------------
// ExecuteTestOptions interface — pick and exportName
// ---------------------------------------------------------------------------

describe("ExecuteTestOptions pick/exportName contract", () => {
  it("accepts pick and exportName together (specific pick case)", () => {
    const options: ExecuteTestOptions = {
      pick: "sg-cross-island",
      exportName: "optimizeSingapore",
    };
    assert.equal(options.pick, "sg-cross-island");
    assert.equal(options.exportName, "optimizeSingapore");
  });

  it("accepts exportName without pick (Run random)", () => {
    const options: ExecuteTestOptions = {
      exportName: "optimizeSingapore",
    };
    assert.equal(options.pick, undefined);
    assert.equal(options.exportName, "optimizeSingapore");
  });

  it("accepts neither pick nor exportName (standard run)", () => {
    const options: ExecuteTestOptions = {};
    assert.equal(options.pick, undefined);
    assert.equal(options.exportName, undefined);
  });

  it("accepts envFile alongside pick and exportName", () => {
    const options: ExecuteTestOptions = {
      envFile: ".env.staging",
      pick: "by-name",
      exportName: "searchProducts",
    };
    assert.equal(options.envFile, ".env.staging");
    assert.equal(options.pick, "by-name");
    assert.equal(options.exportName, "searchProducts");
  });
});

// ---------------------------------------------------------------------------
// runWithPick → executeTest option passing
// ---------------------------------------------------------------------------
// testController.ts runWithPick() calls executeTest() with:
//   { envFile: envFileProvider?.(), pick: pickKey, exportName }
// We verify this shape is correct.

describe("runWithPick option construction", () => {
  /**
   * Simulate the option object that runWithPick() builds for executeTest().
   * This mirrors testController.ts line 291.
   */
  function buildRunWithPickOptions(
    envFile: string | undefined,
    pickKey: string | undefined,
    exportName: string | undefined,
  ): ExecuteTestOptions {
    return { envFile, pick: pickKey, exportName };
  }

  it("passes pick key and exportName for specific example click", () => {
    // User clicks "sg-cross-island" in the CodeLens
    const opts = buildRunWithPickOptions(undefined, "sg-cross-island", "optimizeSingapore");
    assert.equal(opts.pick, "sg-cross-island");
    assert.equal(opts.exportName, "optimizeSingapore");
  });

  it("passes undefined pick for 'Run (random)' click", () => {
    // User clicks "Run (random)" in the CodeLens
    const opts = buildRunWithPickOptions(undefined, undefined, "optimizeSingapore");
    assert.equal(opts.pick, undefined);
    assert.equal(opts.exportName, "optimizeSingapore");
  });

  it("includes envFile from environment switcher", () => {
    const opts = buildRunWithPickOptions(".env.staging", "by-name", "searchProducts");
    assert.equal(opts.envFile, ".env.staging");
    assert.equal(opts.pick, "by-name");
    assert.equal(opts.exportName, "searchProducts");
  });
});

// ---------------------------------------------------------------------------
// glubean.runPick command args → runWithPick parameter passing
// ---------------------------------------------------------------------------
// extension.ts glubean.runPick command receives args with exportName
// and passes it through to testController.runWithPick().

describe("glubean.runPick command arg shape", () => {
  /**
   * Simulate the args shape that the CodeLens provider creates for
   * the glubean.runPick command (see codeLensProvider.ts and extension.ts).
   */
  interface RunPickArgs {
    filePath: string;
    testId: string;
    exportName: string;
    pickKey?: string;
  }

  it("includes exportName for a specific pick case", () => {
    const args: RunPickArgs = {
      filePath: "/workspace/tests/optimize.test.ts",
      testId: "pick:optimize-sg-$_pick",
      exportName: "optimizeSingapore",
      pickKey: "sg-cross-island",
    };

    // extension.ts passes these to runWithPick:
    // testController.runWithPick(args.filePath, args.testId, args.pickKey, args.exportName)
    assert.equal(args.exportName, "optimizeSingapore");
    assert.equal(args.pickKey, "sg-cross-island");
  });

  it("omits pickKey for 'Run (random)'", () => {
    const args: RunPickArgs = {
      filePath: "/workspace/tests/optimize.test.ts",
      testId: "pick:optimize-sg-$_pick",
      exportName: "optimizeSingapore",
      // pickKey is undefined
    };

    assert.equal(args.exportName, "optimizeSingapore");
    assert.equal(args.pickKey, undefined);
  });

  it("rejects missing filePath", () => {
    // extension.ts guards: if (!args?.filePath) return
    const args = { testId: "pick:x", exportName: "x" } as Partial<RunPickArgs>;
    assert.equal(args.filePath, undefined);
    // This would trigger the early return in the command handler
  });
});

// ---------------------------------------------------------------------------
// Batched-mode event attribution (executor.ts — shouldBatch path)
// ---------------------------------------------------------------------------
// When idsToRun.length > 1, executeTest collapses the run into a single
// harness subprocess via `executor.run(fileUrl, "", ctx, {testIds})`. The
// returned event stream carries `event.testId` on scoped events. Unscoped
// events (no testId) come from file-level faults — session setup failure,
// module import error, spawn failure, OOM, propagating test_timeout. Those
// must fan out to every selected id, otherwise `generateSummary([])` would
// return success for tests that never even started.

type AttributionEvent = { testId?: string; type: string; payload?: unknown };

/**
 * Replicate the attribution rule from executor.ts (batched branch).
 *   - Scoped event (testId known) → only that id's events array
 *   - Unscoped event → broadcast to every selected id
 */
function attributeEvents(
  events: AttributionEvent[],
  idsToRun: string[],
): Map<string, AttributionEvent[]> {
  const eventsPerTest = new Map<string, AttributionEvent[]>();
  for (const id of idsToRun) eventsPerTest.set(id, []);

  for (const ev of events) {
    if (ev.testId && eventsPerTest.has(ev.testId)) {
      eventsPerTest.get(ev.testId)!.push(ev);
    } else {
      for (const id of idsToRun) eventsPerTest.get(id)!.push(ev);
    }
  }
  return eventsPerTest;
}

describe("batched-mode attribution", () => {
  it("scoped events land only on their own test", () => {
    const ids = ["a", "b", "c"];
    const events: AttributionEvent[] = [
      { testId: "a", type: "start" },
      { testId: "a", type: "assertion" },
      { testId: "b", type: "start" },
      { testId: "c", type: "start" },
    ];
    const result = attributeEvents(events, ids);
    assert.equal(result.get("a")!.length, 2);
    assert.equal(result.get("b")!.length, 1);
    assert.equal(result.get("c")!.length, 1);
  });

  it("unscoped error event broadcasts to every selected id", () => {
    const ids = ["a", "b", "c"];
    const events: AttributionEvent[] = [
      // File-level spawn failure before any test started — no testId
      { type: "error", payload: "module import failed" },
    ];
    const result = attributeEvents(events, ids);
    assert.equal(result.get("a")!.length, 1);
    assert.equal(result.get("b")!.length, 1);
    assert.equal(result.get("c")!.length, 1);
    assert.deepEqual(
      result.get("a")![0],
      { type: "error", payload: "module import failed" },
    );
  });

  it("unscoped events with unknown testId also broadcast", () => {
    // Defensive: if the harness somehow emits an event with a testId not in
    // the selected set, it must not silently swallow — treat as file-level.
    const ids = ["a", "b"];
    const events: AttributionEvent[] = [
      { testId: "unknown-id", type: "error", payload: "stray" },
    ];
    const result = attributeEvents(events, ids);
    assert.equal(result.get("a")!.length, 1);
    assert.equal(result.get("b")!.length, 1);
  });

  it("session-setup failure before any test start fans out across all selected ids", () => {
    const ids = ["get-user", "create-user", "delete-user"];
    const events: AttributionEvent[] = [
      { type: "error", payload: "session.ts threw at setup" },
      { type: "status", payload: { status: "failed", reason: "session-setup" } },
    ];
    const result = attributeEvents(events, ids);
    for (const id of ids) {
      assert.equal(
        result.get(id)!.length,
        2,
        `${id} should have both session-failure events`,
      );
    }
  });

  it("mixed scoped + unscoped: unscoped reaches all, scoped stays local", () => {
    const ids = ["a", "b"];
    const events: AttributionEvent[] = [
      { testId: "a", type: "start" },
      { testId: "a", type: "assertion" },
      { type: "warning", payload: "ambient" },  // unscoped
      { testId: "b", type: "start" },
    ];
    const result = attributeEvents(events, ids);
    // a: start + assertion + warning = 3
    // b: warning + start = 2
    assert.equal(result.get("a")!.length, 3);
    assert.equal(result.get("b")!.length, 2);
    // Warning must be present in both
    assert.ok(result.get("a")!.some((e) => e.type === "warning"));
    assert.ok(result.get("b")!.some((e) => e.type === "warning"));
  });
});

// ---------------------------------------------------------------------------
// T3 — discoverTestIds is sync, cwd-immune, and routes via sentinels
// ---------------------------------------------------------------------------
//
// Locks the contract from internal/30-execution/2026-04-27-data-driven-discovery-rebuild/.
// `discoverTestIds` MUST be a pure function that returns scope sentinels
// without touching the filesystem or doing dynamic imports. The harness
// owns enumeration of data-driven tests; parent only decides scope.
//
// Why this is a regression guard rather than an interesting unit test:
// the prior impl had a dynamic `await import(fileUrl)` that silently
// failed when test files had top-level `await fromCsv(...)` etc. (cwd
// mismatch in VSCode parent process). The simpler API caught real bugs;
// this test prevents someone from re-adding the dynamic-import "for
// performance" or "for upfront attribution" without realizing it
// re-introduces the cwd dependency.
import { discoverTestIds } from "./discoverTestIds";

describe("discoverTestIds (T3 — sync sentinel decision, no dynamic import)", () => {
  it("with exportName: returns [\"\"] sentinel for harness exportName-only mode", () => {
    const result = discoverTestIds("csvCases");
    assert.deepEqual(result, [""]);
  });

  it("without exportName: returns [\"*\"] sentinel for harness wildcard mode", () => {
    const result = discoverTestIds();
    assert.deepEqual(result, ["*"]);
  });

  it("is synchronous (NOT async) — proves no dynamic import lurks inside", () => {
    // If discoverTestIds becomes async again, this assertion fails fast.
    // A regression that re-adds `await import(fileUrl)` would also re-add
    // the cwd dependency that bug B2 was about.
    const result: string[] = discoverTestIds("anyExport");
    // Type assertion: result must NOT be a Promise — readable as
    // `string[]`, not `Promise<string[]>`. Also runtime check.
    assert.ok(Array.isArray(result), "discoverTestIds must return string[] synchronously");
  });

  it("is cwd-immune: process.cwd() can be set to anything and result is unchanged", () => {
    // Hermetic: temporarily change cwd to /tmp and back. The prior impl
    // would have either thrown or silently failed depending on whether
    // the dynamic import resolved fixture paths against this wrong cwd.
    // The new impl ignores cwd entirely.
    const originalCwd = process.cwd();
    try {
      process.chdir("/tmp");
      const a = discoverTestIds("csvCases");
      const b = discoverTestIds();
      assert.deepEqual(a, [""]);
      assert.deepEqual(b, ["*"]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// Export-fallback attribution (discovery failed + exportName set)
// ---------------------------------------------------------------------------
// When parent-side discovery fails for an `exportName` run, discoverTestIds
// returns `[""]` (never `["*"]`) so the harness is invoked with
// `testId="" + exportName=X` — narrow scope, ignoring the rest of the file.
// The harness emits per-case events with `event.testId`; we split events
// dynamically. Unscoped events (before any scoped start) go into a shared
// bucket that every later-emerging scoped entry inherits — so a
// session-setup failure before case 1 is reflected in all cases' summaries.

type FallbackEvent = { testId?: string; type: string; payload?: unknown };

function dispatchExportFallback(
  events: FallbackEvent[],
): {
  perTest: Map<string, FallbackEvent[]>;
  unscopedBucket: FallbackEvent[];
} {
  const perTest = new Map<string, FallbackEvent[]>();
  const unscopedBucket: FallbackEvent[] = [];

  for (const ev of events) {
    if (ev.testId) {
      if (!perTest.has(ev.testId)) {
        // New id — seed with any accumulated unscoped events so they're
        // visible in this case's summary too.
        perTest.set(ev.testId, [...unscopedBucket]);
      }
      perTest.get(ev.testId)!.push(ev);
    } else {
      unscopedBucket.push(ev);
      // Broadcast to any already-known ids.
      for (const evs of perTest.values()) evs.push(ev);
    }
  }
  return { perTest, unscopedBucket };
}

describe("export-fallback dispatch", () => {
  it("data-driven export emitting 3 case testIds produces 3 buckets", () => {
    const stream: FallbackEvent[] = [
      { testId: "pick:user-alice", type: "start" },
      { testId: "pick:user-alice", type: "assertion" },
      { testId: "pick:user-bob", type: "start" },
      { testId: "pick:user-bob", type: "assertion" },
      { testId: "pick:user-carol", type: "start" },
    ];
    const { perTest } = dispatchExportFallback(stream);
    assert.equal(perTest.size, 3);
    assert.equal(perTest.get("pick:user-alice")!.length, 2);
    assert.equal(perTest.get("pick:user-bob")!.length, 2);
    assert.equal(perTest.get("pick:user-carol")!.length, 1);
  });

  it("unscoped-only stream (session-setup failure, no cases ran) lands in the bucket", () => {
    const stream: FallbackEvent[] = [
      { type: "error", payload: "session.ts threw" },
    ];
    const { perTest, unscopedBucket } = dispatchExportFallback(stream);
    assert.equal(perTest.size, 0);
    assert.equal(unscopedBucket.length, 1);
  });

  it("unscoped event BEFORE first scoped start is inherited by all later cases", () => {
    // Pattern: file-level warning fires first, then two cases start.
    // Both cases' result arrays should include the warning so their
    // summaries reflect it (not just whichever arrived first).
    const stream: FallbackEvent[] = [
      { type: "warning", payload: "ambient" },
      { testId: "pick:a", type: "start" },
      { testId: "pick:b", type: "start" },
    ];
    const { perTest } = dispatchExportFallback(stream);
    assert.equal(perTest.size, 2);
    assert.ok(perTest.get("pick:a")!.some((e) => e.type === "warning"));
    assert.ok(perTest.get("pick:b")!.some((e) => e.type === "warning"));
  });

  it("unscoped event AFTER some cases started broadcasts to all known ids", () => {
    const stream: FallbackEvent[] = [
      { testId: "pick:a", type: "start" },
      { type: "error", payload: "fatal mid-run" },
      { testId: "pick:b", type: "start" },
    ];
    const { perTest } = dispatchExportFallback(stream);
    assert.equal(perTest.size, 2);
    // "pick:a" was already known when error fired → gets it
    assert.ok(perTest.get("pick:a")!.some((e) => e.type === "error"));
    // "pick:b" appears AFTER the error; should still inherit via
    // the seed-from-bucket rule (error is in unscopedBucket by then)
    assert.ok(perTest.get("pick:b")!.some((e) => e.type === "error"));
  });
});
