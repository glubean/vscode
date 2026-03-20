/**
 * P1 regression tests for result history cleanup logic.
 *
 * Tests the cleanupResultDir logic from testController/artifacts.ts.
 * Replicated here as a pure function to avoid vscode API dependency.
 *
 * Run with: npx tsx --test src/result-cleanup.test.ts
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Replicate: cleanupResultDir (from testController/artifacts.ts line 112-126)
// ---------------------------------------------------------------------------

function cleanupResultDir(dir: string, limit: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".result.json"))
      .sort();
    if (files.length <= limit) return;
    const toDelete = files.slice(0, files.length - limit);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    // Non-critical
  }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-cleanup-"));
  tempDirs.push(dir);
  return dir;
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function writeResultFiles(dir: string, count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const hour = p2(Math.floor(i / 60));
    const min = p2(i % 60);
    const name = `20260101T${hour}${min}00.result.json`;
    fs.writeFileSync(path.join(dir, name), "{}", "utf-8");
    names.push(name);
  }
  return names;
}

function listResultFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".result.json"))
    .sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupResultDir", () => {
  it("deletes oldest files when count exceeds limit", () => {
    const dir = makeTempDir();
    writeResultFiles(dir, 25);

    cleanupResultDir(dir, 20);

    const remaining = listResultFiles(dir);
    assert.equal(remaining.length, 20);

    // The 5 oldest (00:00 through 00:04) should be gone
    assert.ok(!remaining.includes("20260101T000000.result.json"));
    assert.ok(!remaining.includes("20260101T000100.result.json"));
    assert.ok(!remaining.includes("20260101T000200.result.json"));
    assert.ok(!remaining.includes("20260101T000300.result.json"));
    assert.ok(!remaining.includes("20260101T000400.result.json"));

    // The newest should still be there
    assert.ok(remaining.includes("20260101T002400.result.json"));
  });

  it("does nothing when count is within limit", () => {
    const dir = makeTempDir();
    writeResultFiles(dir, 15);

    cleanupResultDir(dir, 20);

    const remaining = listResultFiles(dir);
    assert.equal(remaining.length, 15);
  });

  it("does nothing for empty directory", () => {
    const dir = makeTempDir();

    // Should not throw
    cleanupResultDir(dir, 20);

    const remaining = fs.readdirSync(dir);
    assert.equal(remaining.length, 0);
  });

  it("does not throw for nonexistent directory", () => {
    // Should not throw — errors are silently caught
    cleanupResultDir("/tmp/nonexistent-glubean-cleanup-dir", 20);
  });

  it("only counts .result.json files toward limit", () => {
    const dir = makeTempDir();
    writeResultFiles(dir, 22);
    // Add non-result files — these should not be counted or deleted
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me", "utf-8");
    fs.writeFileSync(path.join(dir, "debug.log"), "keep me", "utf-8");

    cleanupResultDir(dir, 20);

    const allFiles = fs.readdirSync(dir);
    const resultFiles = allFiles.filter((f) => f.endsWith(".result.json"));
    const otherFiles = allFiles.filter((f) => !f.endsWith(".result.json"));

    assert.equal(resultFiles.length, 20);
    assert.equal(otherFiles.length, 2); // notes.txt and debug.log untouched
  });
});
