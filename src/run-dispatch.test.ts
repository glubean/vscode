/**
 * Tests for the run dispatch logic in testController.ts.
 *
 * Verifies that:
 * 1. runFile always passes undefined testIds (wildcard mode)
 * 2. runSingleTest uses exportName for data-driven tests (each:/pick:)
 * 3. runSingleTest uses filterId for plain tests
 * 4. isWholeFile correctly determines file-level vs single-test runs
 * 5. findNearestPackageDir resolves to correct package dir in monorepos
 *
 * These tests replicate the decision logic from testController.ts without
 * depending on VS Code APIs.
 *
 * Run with: npx tsx --test src/run-dispatch.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { normalizeFilterId } from "./testController.utils";

// ---------------------------------------------------------------------------
// Types mirroring testController.ts
// ---------------------------------------------------------------------------

interface TestMeta {
  type: "test";
  id: string;
  name?: string;
  exportName: string;
  line: number;
}

/**
 * Replicate the executeTest call shape that runFile and runSingleTest build.
 * This captures the testIds and exportName that would be passed to the executor.
 */
interface ExecuteTestCall {
  testIds: string[] | undefined;
  exportName: string | undefined;
}

// ---------------------------------------------------------------------------
// Logic extracted from testController.ts
// ---------------------------------------------------------------------------

/**
 * Replicate runFile's executeTest call (testController.ts:1383-1390).
 *
 * After the fix, runFile always passes undefined for testIds to let the
 * harness discover tests via wildcard mode.
 */
function buildRunFileCall(_tests: TestMeta[]): ExecuteTestCall {
  return {
    testIds: undefined, // whole-file run — wildcard mode
    exportName: undefined,
  };
}

/**
 * Replicate runSingleTest's executeTest call (testController.ts:1416-1444).
 */
function buildRunSingleTestCall(meta: TestMeta): ExecuteTestCall {
  const isDataDriven = meta.id.startsWith("each:") || meta.id.startsWith("pick:");
  const filterId = normalizeFilterId(meta.id);
  const useExportName = isDataDriven && meta.exportName;

  return {
    testIds: useExportName ? undefined : [filterId],
    exportName: useExportName ? meta.exportName : undefined,
  };
}

/**
 * Replicate isWholeFile check (testController.ts:1083-1085).
 */
function isWholeFile(selectedCount: number, totalChildCount: number): boolean {
  return selectedCount === totalChildCount;
}

/**
 * Replicate the dispatch decision (testController.ts:1087-1097).
 */
function dispatchRun(
  tests: TestMeta[],
  totalChildCount: number,
): ExecuteTestCall[] {
  if (isWholeFile(tests.length, totalChildCount)) {
    return [buildRunFileCall(tests)];
  }
  return tests.map(buildRunSingleTestCall);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runFile dispatch (whole-file wildcard)", () => {
  it("passes undefined testIds for whole-file run", () => {
    const tests: TestMeta[] = [
      { type: "test", id: "health", exportName: "healthCheck", line: 1 },
      { type: "test", id: "smoke", exportName: "smokeTest", line: 10 },
    ];
    const call = buildRunFileCall(tests);
    assert.equal(call.testIds, undefined);
    assert.equal(call.exportName, undefined);
  });

  it("passes undefined even when file has only data-driven tests", () => {
    const tests: TestMeta[] = [
      { type: "test", id: "each:dj-csv-$label", exportName: "csvCases", line: 1 },
    ];
    const call = buildRunFileCall(tests);
    assert.equal(call.testIds, undefined);
  });

  it("passes undefined for mixed plain + data-driven tests", () => {
    const tests: TestMeta[] = [
      { type: "test", id: "health", exportName: "healthCheck", line: 1 },
      { type: "test", id: "each:user-$id", exportName: "userTests", line: 10 },
      { type: "test", id: "pick:search-$_pick", exportName: "searchTest", line: 20 },
    ];
    const call = buildRunFileCall(tests);
    assert.equal(call.testIds, undefined);
  });
});

describe("runSingleTest dispatch", () => {
  it("uses filterId for plain test", () => {
    const meta: TestMeta = { type: "test", id: "health-check", exportName: "healthCheck", line: 1 };
    const call = buildRunSingleTestCall(meta);
    assert.deepEqual(call.testIds, ["health-check"]);
    assert.equal(call.exportName, undefined);
  });

  it("uses exportName for each: data-driven test", () => {
    const meta: TestMeta = { type: "test", id: "each:dj-csv-$label", exportName: "csvCases", line: 1 };
    const call = buildRunSingleTestCall(meta);
    assert.equal(call.testIds, undefined);
    assert.equal(call.exportName, "csvCases");
  });

  it("uses exportName for pick: data-driven test", () => {
    const meta: TestMeta = { type: "test", id: "pick:search-$_pick", exportName: "searchProducts", line: 1 };
    const call = buildRunSingleTestCall(meta);
    assert.equal(call.testIds, undefined);
    assert.equal(call.exportName, "searchProducts");
  });

  it("falls back to filterId when each: test has no exportName", () => {
    const meta: TestMeta = { type: "test", id: "each:user-$id", exportName: "", line: 1 };
    const call = buildRunSingleTestCall(meta);
    // empty exportName is falsy, so useExportName = false
    assert.deepEqual(call.testIds, ["user-"]);
    assert.equal(call.exportName, undefined);
  });

  it("normalizes filterId by stripping prefix and template vars", () => {
    const meta: TestMeta = { type: "test", id: "each:item-$index-$name", exportName: "", line: 1 };
    const call = buildRunSingleTestCall(meta);
    assert.deepEqual(call.testIds, ["item--"]);
  });
});

describe("isWholeFile detection", () => {
  it("returns true when all children are selected", () => {
    assert.equal(isWholeFile(3, 3), true);
  });

  it("returns false when subset of children is selected", () => {
    assert.equal(isWholeFile(1, 3), false);
  });

  it("returns true for single-test file with that test selected", () => {
    // This is the csv.test.ts case — only one export, clicking it = whole file
    assert.equal(isWholeFile(1, 1), true);
  });

  it("returns false when no tests selected (edge case)", () => {
    assert.equal(isWholeFile(0, 3), false);
  });
});

describe("dispatch decision (runFile vs runSingleTest)", () => {
  it("dispatches to runFile when all tests selected (whole file)", () => {
    const tests: TestMeta[] = [
      { type: "test", id: "each:dj-csv-$label", exportName: "csvCases", line: 1 },
    ];
    const calls = dispatchRun(tests, 1);
    // Single runFile call with undefined testIds
    assert.equal(calls.length, 1);
    assert.equal(calls[0].testIds, undefined);
    assert.equal(calls[0].exportName, undefined);
  });

  it("dispatches to runSingleTest for each test when subset selected", () => {
    const tests: TestMeta[] = [
      { type: "test", id: "health", exportName: "healthCheck", line: 1 },
      { type: "test", id: "each:user-$id", exportName: "userTests", line: 10 },
    ];
    const calls = dispatchRun(tests, 5); // 5 total children, 2 selected = not whole file
    assert.equal(calls.length, 2);
    // First: plain test
    assert.deepEqual(calls[0].testIds, ["health"]);
    assert.equal(calls[0].exportName, undefined);
    // Second: data-driven test
    assert.equal(calls[1].testIds, undefined);
    assert.equal(calls[1].exportName, "userTests");
  });

  it("the bug scenario: single each: test in file dispatches to runFile with undefined", () => {
    // csv.test.ts has only `csvCases` (test.each). Clicking it → isWholeFile=true → runFile.
    // Before fix: runFile passed ["each:dj-csv-$label"] → harness couldn't find it.
    // After fix: runFile passes undefined → harness uses wildcard mode.
    const tests: TestMeta[] = [
      { type: "test", id: "each:dj-csv-$label", exportName: "csvCases", line: 18 },
    ];
    const calls = dispatchRun(tests, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].testIds, undefined, "runFile must pass undefined testIds, not template IDs");
  });
});

// ---------------------------------------------------------------------------
// findNearestPackageDir — core logic of workspaceRootFor
// ---------------------------------------------------------------------------

/**
 * Replicate the package.json walk-up logic from workspaceRootFor
 * (testController.ts), extracted for testing without VS Code APIs.
 *
 * Walks up from filePath looking for the nearest package.json,
 * stopping at ceiling (workspace folder root or filesystem root).
 */
function findNearestPackageDir(filePath: string, ceiling: string): string | undefined {
  let dir = path.dirname(filePath);
  while (dir.length >= ceiling.length) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

describe("findNearestPackageDir (workspaceRootFor core logic)", () => {
  let tmpDir: string;

  // Create a temp monorepo structure for testing:
  //   tmp/
  //     package.json              ← workspace root
  //     pnpm-workspace.yaml
  //     test-after/
  //       package.json            ← package
  //       explore/
  //         dummyjson/
  //           smoke.test.ts
  //     contract-first/
  //       package.json            ← package
  //       contracts/
  //         auth.contract.ts

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-test-"));

    // Workspace root
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"private":true}');
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - test-after\n  - contract-first\n");

    // test-after package
    fs.mkdirSync(path.join(tmpDir, "test-after", "explore", "dummyjson"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "test-after", "package.json"), '{"name":"test-after"}');
    fs.writeFileSync(path.join(tmpDir, "test-after", "explore", "dummyjson", "smoke.test.ts"), "");

    // contract-first package
    fs.mkdirSync(path.join(tmpDir, "contract-first", "contracts"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "contract-first", "package.json"), '{"name":"contract-first"}');
    fs.writeFileSync(path.join(tmpDir, "contract-first", "contracts", "auth.contract.ts"), "");
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it("resolves to package dir, not workspace root, for monorepo file", () => {
    setup();
    try {
      const filePath = path.join(tmpDir, "test-after", "explore", "dummyjson", "smoke.test.ts");
      const result = findNearestPackageDir(filePath, tmpDir);
      assert.equal(result, path.join(tmpDir, "test-after"));
    } finally {
      cleanup();
    }
  });

  it("resolves to contract-first package dir for contract file", () => {
    setup();
    try {
      const filePath = path.join(tmpDir, "contract-first", "contracts", "auth.contract.ts");
      const result = findNearestPackageDir(filePath, tmpDir);
      assert.equal(result, path.join(tmpDir, "contract-first"));
    } finally {
      cleanup();
    }
  });

  it("resolves to project root for single-project (non-monorepo)", () => {
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-single-"));
    try {
      fs.writeFileSync(path.join(singleDir, "package.json"), '{"name":"my-project"}');
      fs.mkdirSync(path.join(singleDir, "explore"), { recursive: true });
      fs.writeFileSync(path.join(singleDir, "explore", "test.ts"), "");

      const filePath = path.join(singleDir, "explore", "test.ts");
      const result = findNearestPackageDir(filePath, singleDir);
      assert.equal(result, singleDir);
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
    }
  });

  it("returns undefined for scratch mode (no package.json)", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-scratch-"));
    try {
      fs.writeFileSync(path.join(scratchDir, "test.ts"), "");

      const filePath = path.join(scratchDir, "test.ts");
      const result = findNearestPackageDir(filePath, scratchDir);
      assert.equal(result, undefined);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
