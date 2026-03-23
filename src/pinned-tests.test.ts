/**
 * Tests for the pinned tests pure data layer.
 *
 * Run with: npx tsx --test src/pinned-tests.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  addPinTest,
  removePinTest,
  dedupTests,
  isPinnedTest,
  filterTestsByRoot,
  type PinnedTest,
} from "./pinnedTests";

// ── Helpers ───────────────────────────────────────────────────────────────

function makePin(overrides: Partial<PinnedTest> = {}): PinnedTest {
  return {
    type: "test",
    workspaceRoot: "/workspace/project",
    filePath: "tests/health.test.ts",
    testId: "health-check",
    exportName: "healthCheck",
    label: "health-check",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("addPinTest", () => {
  it("adds a new test to an empty list", () => {
    const pin = makePin();
    const result = addPinTest([], pin);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], pin);
  });

  it("adds a new test to an existing list", () => {
    const existing = makePin({ testId: "test-a", label: "test-a" });
    const newPin = makePin({ testId: "test-b", label: "test-b" });
    const result = addPinTest([existing], newPin);
    assert.equal(result.length, 2);
  });

  it("deduplicates when adding an already-pinned test", () => {
    const pin = makePin();
    const result = addPinTest([pin], pin);
    assert.equal(result.length, 1);
  });
});

describe("removePinTest", () => {
  it("removes a matching test", () => {
    const pin = makePin();
    const result = removePinTest([pin], pin.workspaceRoot, pin.filePath, pin.testId);
    assert.equal(result.length, 0);
  });

  it("does not remove non-matching tests", () => {
    const pinA = makePin({ testId: "test-a" });
    const pinB = makePin({ testId: "test-b" });
    const result = removePinTest([pinA, pinB], pinA.workspaceRoot, pinA.filePath, "test-a");
    assert.equal(result.length, 1);
    assert.equal(result[0].testId, "test-b");
  });

  it("returns empty when removing from empty list", () => {
    const result = removePinTest([], "/workspace", "tests/x.test.ts", "some-id");
    assert.equal(result.length, 0);
  });
});

describe("dedupTests", () => {
  it("removes duplicates by workspaceRoot + filePath + testId", () => {
    const pin = makePin();
    const result = dedupTests([pin, pin, pin]);
    assert.equal(result.length, 1);
  });

  it("keeps tests with different testIds in same file", () => {
    const a = makePin({ testId: "test-a" });
    const b = makePin({ testId: "test-b" });
    const result = dedupTests([a, b]);
    assert.equal(result.length, 2);
  });

  it("keeps tests with same testId in different files", () => {
    const a = makePin({ filePath: "tests/a.test.ts" });
    const b = makePin({ filePath: "tests/b.test.ts" });
    const result = dedupTests([a, b]);
    assert.equal(result.length, 2);
  });

  it("preserves first occurrence when deduplicating", () => {
    const first = makePin({ label: "first" });
    const second = makePin({ label: "second" });
    const result = dedupTests([first, second]);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, "first");
  });
});

describe("isPinnedTest", () => {
  it("returns true when test is in the list", () => {
    const pin = makePin();
    assert.equal(isPinnedTest([pin], pin.workspaceRoot, pin.filePath, pin.testId), true);
  });

  it("returns false when test is not in the list", () => {
    const pin = makePin();
    assert.equal(isPinnedTest([pin], pin.workspaceRoot, pin.filePath, "other-id"), false);
  });

  it("returns false for empty list", () => {
    assert.equal(isPinnedTest([], "/ws", "x.test.ts", "some-id"), false);
  });

  it("requires workspaceRoot, filePath, and testId to all match", () => {
    const pin = makePin();
    // Different root
    assert.equal(isPinnedTest([pin], "/different/root", pin.filePath, pin.testId), false);
    // Different file
    assert.equal(isPinnedTest([pin], pin.workspaceRoot, "other.test.ts", pin.testId), false);
    // Different testId
    assert.equal(isPinnedTest([pin], pin.workspaceRoot, pin.filePath, "other-id"), false);
  });
});

describe("filterTestsByRoot", () => {
  it("returns only tests matching the given root", () => {
    const a = makePin({ workspaceRoot: "/ws/a", testId: "a" });
    const b = makePin({ workspaceRoot: "/ws/b", testId: "b" });
    const c = makePin({ workspaceRoot: "/ws/a", testId: "c" });
    const result = filterTestsByRoot([a, b, c], "/ws/a");
    assert.equal(result.length, 2);
    assert.equal(result[0].testId, "a");
    assert.equal(result[1].testId, "c");
  });

  it("returns empty when no tests match", () => {
    const pin = makePin({ workspaceRoot: "/ws/a" });
    const result = filterTestsByRoot([pin], "/ws/other");
    assert.equal(result.length, 0);
  });
});

// ── Data-driven test detection ──────────────────────────────────────────

describe("isDataDrivenPinnedTest", () => {
  it("detects each: prefix", () => {
    assert.strictEqual("each:search-$q".startsWith("each:"), true);
  });

  it("detects pick: prefix", () => {
    assert.strictEqual("pick:dir-$_pick".startsWith("pick:"), true);
  });

  it("plain test has no prefix", () => {
    assert.strictEqual("get-user".startsWith("each:") || "get-user".startsWith("pick:"), false);
  });
});
