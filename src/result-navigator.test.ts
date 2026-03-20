/**
 * P1 regression tests for result navigator prev/next logic.
 *
 * The navigator in resultNavigator.ts is tightly coupled to vscode API,
 * so we replicate the pure logic (listResultFiles, navigation index math)
 * here with real temp directories.
 *
 * Run with: npx tsx --test src/result-navigator.test.ts
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Replicate: listResultFiles (from resultNavigator.ts line 168-178)
// ---------------------------------------------------------------------------

/**
 * List .result.json files in a directory, sorted newest first.
 * Returns empty array if directory doesn't exist.
 */
function listResultFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".result.json"))
      .sort()
      .reverse(); // newest first (filenames are timestamps)
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Replicate: navigation index logic (from resultNavigator.ts)
// ---------------------------------------------------------------------------

/**
 * Given sorted files (newest first) and a current index,
 * return the filename at prev (older) position, or null if at boundary.
 */
function navigatePrev(
  files: string[],
  currentIndex: number,
): string | null {
  if (files.length === 0) return null;
  if (currentIndex >= files.length - 1) return null;
  return files[currentIndex + 1];
}

/**
 * Given sorted files (newest first) and a current index,
 * return the filename at next (newer) position, or null if at boundary.
 */
function navigateNext(
  files: string[],
  currentIndex: number,
): string | null {
  if (files.length === 0) return null;
  if (currentIndex <= 0) return null;
  return files[currentIndex - 1];
}

/**
 * Count result files for a directory.
 */
function countResultFiles(dir: string): number {
  return listResultFiles(dir).length;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-nav-"));
  tempDirs.push(dir);
  return dir;
}

function writeResultFile(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), "{}", "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("result navigator: prev/next", () => {
  it("3 files, current is middle -> prev returns oldest, next returns newest", () => {
    const dir = makeTempDir();
    writeResultFile(dir, "20260101T100000.result.json");
    writeResultFile(dir, "20260101T110000.result.json");
    writeResultFile(dir, "20260101T120000.result.json");

    const files = listResultFiles(dir);
    // files sorted newest first: [120000, 110000, 100000]
    assert.deepEqual(files, [
      "20260101T120000.result.json",
      "20260101T110000.result.json",
      "20260101T100000.result.json",
    ]);

    // Current is middle (index 1 = 110000)
    const prev = navigatePrev(files, 1);
    const next = navigateNext(files, 1);

    assert.equal(prev, "20260101T100000.result.json"); // older
    assert.equal(next, "20260101T120000.result.json"); // newer
  });

  it("current is oldest -> prev returns null", () => {
    const dir = makeTempDir();
    writeResultFile(dir, "20260101T100000.result.json");
    writeResultFile(dir, "20260101T110000.result.json");
    writeResultFile(dir, "20260101T120000.result.json");

    const files = listResultFiles(dir);
    // index 2 = oldest (100000)
    assert.equal(navigatePrev(files, 2), null);
  });

  it("current is newest -> next returns null", () => {
    const dir = makeTempDir();
    writeResultFile(dir, "20260101T100000.result.json");
    writeResultFile(dir, "20260101T110000.result.json");
    writeResultFile(dir, "20260101T120000.result.json");

    const files = listResultFiles(dir);
    // index 0 = newest (120000)
    assert.equal(navigateNext(files, 0), null);
  });

  it("empty directory -> both return null", () => {
    const dir = makeTempDir();

    const files = listResultFiles(dir);
    assert.equal(files.length, 0);
    assert.equal(navigatePrev(files, 0), null);
    assert.equal(navigateNext(files, 0), null);
  });
});

describe("countResultFiles", () => {
  it("counts only .result.json files", () => {
    const dir = makeTempDir();
    writeResultFile(dir, "20260101T100000.result.json");
    writeResultFile(dir, "20260101T110000.result.json");
    writeResultFile(dir, "20260101T120000.result.json");
    // non-result files should be ignored
    fs.writeFileSync(path.join(dir, "readme.txt"), "ignore", "utf-8");
    fs.writeFileSync(path.join(dir, "data.json"), "{}", "utf-8");

    assert.equal(countResultFiles(dir), 3);
  });

  it("returns 0 for nonexistent directory", () => {
    assert.equal(countResultFiles("/tmp/nonexistent-glubean-test-dir"), 0);
  });
});

describe("filename sorting (timestamp order)", () => {
  it("sorts by timestamp descending (newest first)", () => {
    const dir = makeTempDir();
    // Write in random order
    writeResultFile(dir, "20260315T090000.result.json");
    writeResultFile(dir, "20260101T010000.result.json");
    writeResultFile(dir, "20260620T230000.result.json");
    writeResultFile(dir, "20260410T120000.result.json");

    const files = listResultFiles(dir);
    assert.deepEqual(files, [
      "20260620T230000.result.json",
      "20260410T120000.result.json",
      "20260315T090000.result.json",
      "20260101T010000.result.json",
    ]);
  });

  it("handles pick-label suffixes correctly in sort order", () => {
    const dir = makeTempDir();
    writeResultFile(dir, "20260101T100000[by-name].result.json");
    writeResultFile(dir, "20260101T100000[by-category].result.json");
    writeResultFile(dir, "20260101T110000.result.json");

    const files = listResultFiles(dir);
    // Same timestamp, bracket suffixes sort after plain
    // '['  (91) > no bracket, so 110000 is newest, then 100000[by-name], 100000[by-category]
    assert.equal(files[0], "20260101T110000.result.json");
    assert.equal(files.length, 3);
  });
});
