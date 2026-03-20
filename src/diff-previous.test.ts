/**
 * P2 regression tests for the diffWithPrevious result-picking logic.
 *
 * We test the pure filesystem logic (find the two newest result files)
 * without touching the vscode API. The actual diffWithPrevious function
 * in trace.ts calls vscode.commands — here we replicate the selection
 * algorithm in isolation.
 *
 * Run with: npx tsx --test src/diff-previous.test.ts
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers — replicate the pure selection logic from trace.ts
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-diff-prev-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a zero-byte result file. */
function touchResult(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}");
  return filePath;
}

/**
 * Collect all .result.json files across subdirectories,
 * sort descending by name, and return the two newest full paths.
 * Returns false if fewer than 2 files exist.
 *
 * This mirrors the logic in trace.ts diffWithPrevious (non-.result.json branch).
 */
function selectTwoNewest(
  fileResultsDir: string,
): { newer: string; older: string } | false {
  let subdirs: fs.Dirent[];
  try {
    subdirs = fs
      .readdirSync(fileResultsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return false;
  }

  const allResults: { name: string; fullPath: string }[] = [];
  for (const sub of subdirs) {
    const subPath = path.join(fileResultsDir, sub.name);
    const results = fs
      .readdirSync(subPath)
      .filter((f) => f.endsWith(".result.json"));
    for (const t of results) {
      allResults.push({ name: t, fullPath: path.join(subPath, t) });
    }
  }

  if (allResults.length < 2) {
    return false;
  }

  allResults.sort((a, b) => b.name.localeCompare(a.name));
  return { newer: allResults[0].fullPath, older: allResults[1].fullPath };
}

/**
 * Select two newest within a single directory.
 * Mirrors diffInDir in trace.ts.
 */
function selectTwoNewestInDir(
  dir: string,
): { newer: string; older: string } | false {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".result.json"));
  } catch {
    return false;
  }

  if (entries.length < 2) return false;

  entries.sort().reverse();
  return {
    newer: path.join(dir, entries[0]),
    older: path.join(dir, entries[1]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diff-previous: selectTwoNewest across subdirectories", () => {
  it("directory has 3 result files in one subdir — selects newest two", () => {
    const base = makeTempDir();
    const subdir = path.join(base, "health-check");
    touchResult(subdir, "20260101T100000.result.json");
    touchResult(subdir, "20260102T100000.result.json");
    touchResult(subdir, "20260103T100000.result.json");

    const result = selectTwoNewest(base);
    assert.notEqual(result, false);
    if (result === false) return;

    assert.ok(result.newer.includes("20260103T100000"));
    assert.ok(result.older.includes("20260102T100000"));
  });

  it("directory has only 1 file — returns false", () => {
    const base = makeTempDir();
    const subdir = path.join(base, "only-test");
    touchResult(subdir, "20260101T100000.result.json");

    const result = selectTwoNewest(base);
    assert.equal(result, false);
  });

  it("directory is empty (no subdirs) — returns false", () => {
    const base = makeTempDir();
    // No subdirs at all
    const result = selectTwoNewest(base);
    assert.equal(result, false);
  });

  it("multiple subdirectories — picks global newest two across all", () => {
    const base = makeTempDir();
    const sub1 = path.join(base, "test-a");
    const sub2 = path.join(base, "test-b");

    touchResult(sub1, "20260101T100000.result.json");
    touchResult(sub1, "20260102T100000.result.json");
    touchResult(sub2, "20260103T100000.result.json");
    touchResult(sub2, "20260104T100000.result.json");

    const result = selectTwoNewest(base);
    assert.notEqual(result, false);
    if (result === false) return;

    // Newest two are both from sub2
    assert.ok(result.newer.includes("20260104T100000"));
    assert.ok(result.older.includes("20260103T100000"));
  });

  it("pick file names sort correctly with bracket suffixes", () => {
    const base = makeTempDir();
    const subdir = path.join(base, "search-");
    touchResult(subdir, "20260101T100000[by-name].result.json");
    touchResult(subdir, "20260102T100000[by-price].result.json");
    touchResult(subdir, "20260103T100000[by-name].result.json");

    const result = selectTwoNewest(base);
    assert.notEqual(result, false);
    if (result === false) return;

    assert.ok(result.newer.includes("20260103T100000[by-name]"));
    assert.ok(result.older.includes("20260102T100000[by-price]"));
  });
});

describe("diff-previous: selectTwoNewestInDir (single dir)", () => {
  it("three files — selects newest two", () => {
    const dir = makeTempDir();
    touchResult(dir, "20260101T100000.result.json");
    touchResult(dir, "20260102T100000.result.json");
    touchResult(dir, "20260103T100000.result.json");

    const result = selectTwoNewestInDir(dir);
    assert.notEqual(result, false);
    if (result === false) return;

    assert.ok(result.newer.includes("20260103T100000"));
    assert.ok(result.older.includes("20260102T100000"));
  });

  it("one file — returns false", () => {
    const dir = makeTempDir();
    touchResult(dir, "20260101T100000.result.json");

    assert.equal(selectTwoNewestInDir(dir), false);
  });

  it("empty directory — returns false", () => {
    const dir = makeTempDir();
    assert.equal(selectTwoNewestInDir(dir), false);
  });

  it("non-result files are ignored", () => {
    const dir = makeTempDir();
    touchResult(dir, "20260101T100000.result.json");
    touchResult(dir, "20260102T100000.result.json");
    fs.writeFileSync(path.join(dir, "readme.txt"), "ignore me");

    const result = selectTwoNewestInDir(dir);
    assert.notEqual(result, false);
    if (result === false) return;
    assert.ok(result.newer.includes("20260102T100000"));
    assert.ok(result.older.includes("20260101T100000"));
  });
});
