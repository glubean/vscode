/**
 * Tests for the pinned files pure data layer.
 *
 * Run with: npx tsx --test src/pinned-files.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { addPin, removePin, dedup, isPinned, filterByRoot, type PinnedFile } from "./pinnedFiles";

// ── Helpers ───────────────────────────────────────────────────────────────

function makePin(overrides: Partial<PinnedFile> = {}): PinnedFile {
  return {
    type: "file",
    workspaceRoot: "/workspace/project",
    filePath: "tests/health.test.ts",
    label: "health.test.ts",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("addPin", () => {
  it("adds a new item to an empty list", () => {
    const pin = makePin();
    const result = addPin([], pin);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], pin);
  });

  it("adds a new item to an existing list", () => {
    const existing = makePin({ filePath: "tests/a.test.ts", label: "a.test.ts" });
    const newPin = makePin({ filePath: "tests/b.test.ts", label: "b.test.ts" });
    const result = addPin([existing], newPin);
    assert.equal(result.length, 2);
  });

  it("deduplicates when adding an already-pinned file", () => {
    const pin = makePin();
    const result = addPin([pin], pin);
    assert.equal(result.length, 1);
  });
});

describe("removePin", () => {
  it("removes a matching file", () => {
    const pin = makePin();
    const result = removePin([pin], pin.workspaceRoot, pin.filePath);
    assert.equal(result.length, 0);
  });

  it("does not remove non-matching files", () => {
    const pinA = makePin({ filePath: "tests/a.test.ts" });
    const pinB = makePin({ filePath: "tests/b.test.ts" });
    const result = removePin([pinA, pinB], pinA.workspaceRoot, "tests/a.test.ts");
    assert.equal(result.length, 1);
    assert.equal(result[0].filePath, "tests/b.test.ts");
  });

  it("returns empty when removing from empty list", () => {
    const result = removePin([], "/workspace", "tests/x.test.ts");
    assert.equal(result.length, 0);
  });
});

describe("dedup", () => {
  it("removes duplicates by workspaceRoot + filePath", () => {
    const pin = makePin();
    const result = dedup([pin, pin, pin]);
    assert.equal(result.length, 1);
  });

  it("keeps items with different filePaths", () => {
    const a = makePin({ filePath: "tests/a.test.ts" });
    const b = makePin({ filePath: "tests/b.test.ts" });
    const result = dedup([a, b]);
    assert.equal(result.length, 2);
  });

  it("keeps items with different workspaceRoots", () => {
    const a = makePin({ workspaceRoot: "/ws/a" });
    const b = makePin({ workspaceRoot: "/ws/b" });
    const result = dedup([a, b]);
    assert.equal(result.length, 2);
  });

  it("preserves first occurrence when deduplicating", () => {
    const first = makePin({ label: "first" });
    const second = makePin({ label: "second" });
    const result = dedup([first, second]);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, "first");
  });
});

describe("isPinned", () => {
  it("returns true when file is in the list", () => {
    const pin = makePin();
    assert.equal(isPinned([pin], pin.workspaceRoot, pin.filePath), true);
  });

  it("returns false when file is not in the list", () => {
    const pin = makePin();
    assert.equal(isPinned([pin], pin.workspaceRoot, "other.test.ts"), false);
  });

  it("returns false for empty list", () => {
    assert.equal(isPinned([], "/ws", "x.test.ts"), false);
  });

  it("requires both workspaceRoot and filePath to match", () => {
    const pin = makePin();
    assert.equal(isPinned([pin], "/different/root", pin.filePath), false);
  });
});

describe("filterByRoot", () => {
  it("returns only items matching the given root", () => {
    const a = makePin({ workspaceRoot: "/ws/a", filePath: "a.test.ts" });
    const b = makePin({ workspaceRoot: "/ws/b", filePath: "b.test.ts" });
    const c = makePin({ workspaceRoot: "/ws/a", filePath: "c.test.ts" });
    const result = filterByRoot([a, b, c], "/ws/a");
    assert.equal(result.length, 2);
    assert.equal(result[0].filePath, "a.test.ts");
    assert.equal(result[1].filePath, "c.test.ts");
  });

  it("returns empty when no items match", () => {
    const pin = makePin({ workspaceRoot: "/ws/a" });
    const result = filterByRoot([pin], "/ws/other");
    assert.equal(result.length, 0);
  });
});

// ── Multi-root description ──────────────────────────────────────────────

describe("multi-root description", () => {
  it("shows workspace prefix when multi-root", () => {
    const pinned = { type: "file" as const, workspaceRoot: "/ws/cookbook", filePath: "tests/smoke.test.ts", label: "smoke.test.ts" };
    const isMultiRoot = true;
    const wsName = "cookbook";
    const desc = isMultiRoot ? `${wsName}/${pinned.filePath}` : pinned.filePath;
    assert.strictEqual(desc, "cookbook/tests/smoke.test.ts");
  });

  it("shows plain path when single root", () => {
    const pinned = { type: "file" as const, workspaceRoot: "/ws/cookbook", filePath: "tests/smoke.test.ts", label: "smoke.test.ts" };
    const isMultiRoot = false;
    const wsName = "cookbook";
    const desc = isMultiRoot ? `${wsName}/${pinned.filePath}` : pinned.filePath;
    assert.strictEqual(desc, "tests/smoke.test.ts");
  });
});
