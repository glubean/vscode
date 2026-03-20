/**
 * P1 regression tests for CLI status bar logic.
 *
 * Tests the pure functions from cliStatus.ts: parseSemver, isNewer,
 * and the status determination logic (updateStatusBar state transitions).
 *
 * Run with: npx tsx --test src/cli-status.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Replicate: parseSemver (from cliStatus.ts line 16-26)
// ---------------------------------------------------------------------------

function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

// ---------------------------------------------------------------------------
// Replicate: isNewer (from cliStatus.ts line 28-35)
// ---------------------------------------------------------------------------

function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

// ---------------------------------------------------------------------------
// Replicate: status determination (from cliStatus.ts line 116-146)
// ---------------------------------------------------------------------------

type CliAction = "install" | "upgrade" | "none";

function determineStatus(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
): { action: CliAction; needsUpdate: boolean } {
  if (!installedVersion) {
    return { action: "install", needsUpdate: true };
  }

  if (latestVersion && isNewer(latestVersion, installedVersion)) {
    return { action: "upgrade", needsUpdate: true };
  }

  return { action: "none", needsUpdate: false };
}

// ---------------------------------------------------------------------------
// Tests: parseSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  it("parses standard semver", () => {
    assert.deepEqual(parseSemver("0.1.15"), { major: 0, minor: 1, patch: 15 });
    assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
  });

  it("parses semver with trailing content (pre-release, build)", () => {
    assert.deepEqual(parseSemver("1.2.3-beta.1"), { major: 1, minor: 2, patch: 3 });
    assert.deepEqual(parseSemver("0.1.20+build.42"), { major: 0, minor: 1, patch: 20 });
  });

  it("returns undefined for non-semver strings", () => {
    assert.equal(parseSemver("not-a-version"), undefined);
    assert.equal(parseSemver(""), undefined);
    assert.equal(parseSemver("1.2"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Tests: isNewer
// ---------------------------------------------------------------------------

describe("isNewer", () => {
  it("local 0.1.15, remote 0.1.20 -> needs update", () => {
    assert.equal(isNewer("0.1.20", "0.1.15"), true);
  });

  it("local 0.1.20, remote 0.1.20 -> up to date", () => {
    assert.equal(isNewer("0.1.20", "0.1.20"), false);
  });

  it("local newer than remote -> no update", () => {
    assert.equal(isNewer("0.1.15", "0.1.20"), false);
  });

  it("compares major version first", () => {
    assert.equal(isNewer("2.0.0", "1.9.9"), true);
    assert.equal(isNewer("1.9.9", "2.0.0"), false);
  });

  it("compares minor version second", () => {
    assert.equal(isNewer("0.2.0", "0.1.99"), true);
    assert.equal(isNewer("0.1.99", "0.2.0"), false);
  });

  it("returns false when either version is invalid", () => {
    assert.equal(isNewer("invalid", "0.1.20"), false);
    assert.equal(isNewer("0.1.20", "invalid"), false);
    assert.equal(isNewer("invalid", "also-invalid"), false);
  });
});

// ---------------------------------------------------------------------------
// Tests: status determination
// ---------------------------------------------------------------------------

describe("determineStatus", () => {
  it("installed null -> install action", () => {
    const result = determineStatus(undefined, "0.1.20");
    assert.equal(result.action, "install");
    assert.equal(result.needsUpdate, true);
  });

  it("installed null, latest also null -> still install", () => {
    const result = determineStatus(undefined, undefined);
    assert.equal(result.action, "install");
    assert.equal(result.needsUpdate, true);
  });

  it("installed < latest -> upgrade action", () => {
    const result = determineStatus("0.1.15", "0.1.20");
    assert.equal(result.action, "upgrade");
    assert.equal(result.needsUpdate, true);
  });

  it("installed == latest -> none action", () => {
    const result = determineStatus("0.1.20", "0.1.20");
    assert.equal(result.action, "none");
    assert.equal(result.needsUpdate, false);
  });

  it("installed > latest -> none action (local ahead)", () => {
    const result = determineStatus("0.1.25", "0.1.20");
    assert.equal(result.action, "none");
    assert.equal(result.needsUpdate, false);
  });

  it("installed present, latest null -> none action (cannot compare)", () => {
    const result = determineStatus("0.1.15", undefined);
    assert.equal(result.action, "none");
    assert.equal(result.needsUpdate, false);
  });
});
