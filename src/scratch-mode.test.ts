/**
 * P0 regression tests for scratch mode detection.
 *
 * Tests isGlubeanFileName (test file detection) and zero-project detection
 * logic from testController.ts. Since testController.ts depends on vscode,
 * we replicate the pure logic here — same pattern as executor.test.ts.
 *
 * Run with: npx tsx --test src/scratch-mode.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Replicate: isGlubeanFileName (from testController.ts line 489-491)
// ---------------------------------------------------------------------------

/** Check if a file name is a Glubean test / contract / flow file. */
function isGlubeanFileName(fileName: string): boolean {
  return /\.(test|contract|flow)\.(ts|js|mjs)$/.test(fileName);
}

// ---------------------------------------------------------------------------
// Replicate: isScratchMode zero-project check (from testController.ts line 61-66)
// The full isScratchMode also checks workspace folders (vscode API), but the
// zero-project part is pure: check if cwd has node_modules/@glubean/sdk.
// ---------------------------------------------------------------------------

/**
 * Check if a directory is a zero-project (no @glubean/sdk installed).
 * This is the fs.existsSync check from isScratchMode.
 */
function isZeroProject(cwd: string): boolean {
  return !fs.existsSync(path.join(cwd, "node_modules", "@glubean", "sdk"));
}

// ---------------------------------------------------------------------------
// Tests: isGlubeanFileName
// ---------------------------------------------------------------------------

describe("isGlubeanFileName", () => {
  it("matches .test.ts", () => {
    assert.equal(isGlubeanFileName("health.test.ts"), true);
    assert.equal(isGlubeanFileName("/workspace/tests/health.test.ts"), true);
  });

  it("matches .test.js", () => {
    assert.equal(isGlubeanFileName("health.test.js"), true);
    assert.equal(isGlubeanFileName("/workspace/tests/api.test.js"), true);
  });

  it("matches .test.mjs", () => {
    assert.equal(isGlubeanFileName("health.test.mjs"), true);
    assert.equal(isGlubeanFileName("/workspace/tests/search.test.mjs"), true);
  });

  it("rejects non-test files", () => {
    assert.equal(isGlubeanFileName("health.ts"), false);
    assert.equal(isGlubeanFileName("test.ts"), false);
    assert.equal(isGlubeanFileName("package.json"), false);
    assert.equal(isGlubeanFileName("README.md"), false);
    assert.equal(isGlubeanFileName("tsconfig.json"), false);
  });

  it("rejects .test with unsupported extensions", () => {
    assert.equal(isGlubeanFileName("health.test.cjs"), false);
    assert.equal(isGlubeanFileName("health.test.tsx"), false);
    assert.equal(isGlubeanFileName("health.test.py"), false);
  });

  it("rejects files that contain .test but are not test files", () => {
    assert.equal(isGlubeanFileName("test.config.ts"), false);
    assert.equal(isGlubeanFileName("testing-utils.ts"), false);
    assert.equal(isGlubeanFileName(".test.hidden"), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: zero-project detection
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-scratch-"));
  tempDirs.push(dir);
  return dir;
}

describe("zero-project detection", () => {
  it("detects zero-project when node_modules/@glubean/sdk is absent", () => {
    const cwd = makeTempDir();
    assert.equal(isZeroProject(cwd), true);
  });

  it("detects zero-project when node_modules exists but no @glubean/sdk", () => {
    const cwd = makeTempDir();
    fs.mkdirSync(path.join(cwd, "node_modules", "some-package"), { recursive: true });
    assert.equal(isZeroProject(cwd), true);
  });

  it("detects full project when node_modules/@glubean/sdk exists", () => {
    const cwd = makeTempDir();
    fs.mkdirSync(path.join(cwd, "node_modules", "@glubean", "sdk"), { recursive: true });
    assert.equal(isZeroProject(cwd), false);
  });
});
