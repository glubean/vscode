/**
 * P0 regression tests for result viewer logic (extracted from ResultViewer.tsx).
 *
 * Tests deriveSuccess, extractAssertions, and extractTraceCalls from
 * src/webview/result-utils.ts.
 *
 * Run with: npx tsx --test src/result-viewer-logic.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { deriveSuccess, extractAssertions, extractTraceCalls } from "./webview/result-utils";
import { inferSourcePath } from "./resultViewerUtils";
import type { TimelineEvent } from "./webview/index";

// ---------------------------------------------------------------------------
// Helper: build a test object for deriveSuccess
// ---------------------------------------------------------------------------

function testEntry(success: boolean, events: TimelineEvent[]) {
  return { success, events };
}

// ---------------------------------------------------------------------------
// deriveSuccess
// ---------------------------------------------------------------------------

describe("deriveSuccess", () => {
  it("returns true when test.success=true and no assertion failures", () => {
    const t = testEntry(true, [
      { type: "assertion", passed: true, message: "ok" },
      { type: "trace", data: { method: "GET", url: "/api", status: 200, duration: 10 } },
    ]);
    assert.equal(deriveSuccess(t), true);
  });

  it("returns false when test.success=false (hard failure)", () => {
    const t = testEntry(false, [
      { type: "assertion", passed: true, message: "ok" },
    ]);
    assert.equal(deriveSuccess(t), false);
  });

  it("returns false when test.success=true but has soft assertion failure", () => {
    const t = testEntry(true, [
      { type: "assertion", passed: true, message: "first check" },
      { type: "assertion", passed: false, message: "soft fail" },
    ]);
    assert.equal(deriveSuccess(t), false);
  });

  it("returns true with no events", () => {
    const t = testEntry(true, []);
    assert.equal(deriveSuccess(t), true);
  });

  it("returns true with only non-assertion events", () => {
    const t = testEntry(true, [
      { type: "log", message: "hello" },
      { type: "trace", data: { method: "GET", url: "/api", status: 200, duration: 10 } },
    ]);
    assert.equal(deriveSuccess(t), true);
  });

  it("returns false when success=false and events empty", () => {
    const t = testEntry(false, []);
    assert.equal(deriveSuccess(t), false);
  });

  it("returns false with multiple mixed assertions where one fails", () => {
    const t = testEntry(true, [
      { type: "assertion", passed: true, message: "check 1" },
      { type: "assertion", passed: true, message: "check 2" },
      { type: "assertion", passed: false, message: "check 3" },
      { type: "assertion", passed: true, message: "check 4" },
    ]);
    assert.equal(deriveSuccess(t), false);
  });
});

// ---------------------------------------------------------------------------
// extractAssertions
// ---------------------------------------------------------------------------

describe("extractAssertions", () => {
  it("returns only assertion events", () => {
    const events: TimelineEvent[] = [
      { type: "log", message: "start" },
      { type: "assertion", passed: true, message: "status ok" },
      { type: "trace", data: { method: "GET", url: "/api", status: 200, duration: 10 } },
      { type: "assertion", passed: false, message: "body check" },
    ];
    const assertions = extractAssertions(events);
    assert.equal(assertions.length, 2);
    assert.equal(assertions[0].type, "assertion");
    assert.equal(assertions[1].type, "assertion");
  });

  it("returns empty for no assertion events", () => {
    const events: TimelineEvent[] = [
      { type: "log", message: "hello" },
      { type: "trace", data: { method: "GET", url: "/api", status: 200, duration: 10 } },
    ];
    assert.deepEqual(extractAssertions(events), []);
  });

  it("returns empty for empty events", () => {
    assert.deepEqual(extractAssertions([]), []);
  });
});

// ---------------------------------------------------------------------------
// extractTraceCalls
// ---------------------------------------------------------------------------

describe("extractTraceCalls", () => {
  it("returns only trace events", () => {
    const events: TimelineEvent[] = [
      { type: "trace", data: { method: "GET", url: "/users", status: 200, duration: 30 } },
      { type: "assertion", passed: true, message: "ok" },
      { type: "trace", data: { method: "POST", url: "/users", status: 201, duration: 50 } },
      { type: "log", message: "done" },
    ];
    const traces = extractTraceCalls(events);
    assert.equal(traces.length, 2);
    assert.equal(traces[0].type, "trace");
    assert.equal(traces[1].type, "trace");
  });

  it("returns empty for no trace events", () => {
    const events: TimelineEvent[] = [
      { type: "assertion", passed: true, message: "ok" },
      { type: "log", message: "hello" },
    ];
    assert.deepEqual(extractTraceCalls(events), []);
  });

  it("returns empty for empty events", () => {
    assert.deepEqual(extractTraceCalls([]), []);
  });
});

// ---------------------------------------------------------------------------
// inferSourcePath
// ---------------------------------------------------------------------------

describe("inferSourcePath", () => {
  let tempDir: string;

  function setup() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-infer-"));
    return tempDir;
  }

  function cleanup() {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("side-file: smoke.test.result.json → smoke.test.ts", () => {
    const dir = setup();
    try {
      // Create the source file
      fs.writeFileSync(path.join(dir, "smoke.test.ts"), "");
      // Create the result file
      fs.writeFileSync(path.join(dir, "smoke.test.result.json"), "{}");

      const result = inferSourcePath(path.join(dir, "smoke.test.result.json"));
      assert.equal(result, path.join(dir, "smoke.test.ts"));
    } finally {
      cleanup();
    }
  });

  it("side-file: prefers .ts over .js", () => {
    const dir = setup();
    try {
      fs.writeFileSync(path.join(dir, "api.test.ts"), "");
      fs.writeFileSync(path.join(dir, "api.test.js"), "");
      fs.writeFileSync(path.join(dir, "api.test.result.json"), "{}");

      const result = inferSourcePath(path.join(dir, "api.test.result.json"));
      assert.equal(result, path.join(dir, "api.test.ts"));
    } finally {
      cleanup();
    }
  });

  it("side-file: falls back to .js when no .ts", () => {
    const dir = setup();
    try {
      fs.writeFileSync(path.join(dir, "api.test.js"), "");
      fs.writeFileSync(path.join(dir, "api.test.result.json"), "{}");

      const result = inferSourcePath(path.join(dir, "api.test.result.json"));
      assert.equal(result, path.join(dir, "api.test.js"));
    } finally {
      cleanup();
    }
  });

  it("side-file: returns undefined when no source file exists", () => {
    const dir = setup();
    try {
      fs.writeFileSync(path.join(dir, "missing.test.result.json"), "{}");

      const result = inferSourcePath(path.join(dir, "missing.test.result.json"));
      assert.equal(result, undefined);
    } finally {
      cleanup();
    }
  });

  it("history: .glubean/results/smoke.test/dj-get/ts.result.json → smoke.test.ts", () => {
    const dir = setup();
    try {
      // Create workspace structure
      fs.writeFileSync(path.join(dir, "smoke.test.ts"), "");
      const histDir = path.join(dir, ".glubean", "results", "smoke.test", "dj-get");
      fs.mkdirSync(histDir, { recursive: true });
      const resultPath = path.join(histDir, "20260318T231054.result.json");
      fs.writeFileSync(resultPath, "{}");

      const result = inferSourcePath(resultPath);
      assert.equal(result, path.join(dir, "smoke.test.ts"));
    } finally {
      cleanup();
    }
  });

  it("history: finds source file in subdirectory", () => {
    const dir = setup();
    try {
      // Source file is in a tests/ subdirectory
      const testsDir = path.join(dir, "tests");
      fs.mkdirSync(testsDir, { recursive: true });
      fs.writeFileSync(path.join(testsDir, "api.test.ts"), "");

      const histDir = path.join(dir, ".glubean", "results", "api.test", "health-check");
      fs.mkdirSync(histDir, { recursive: true });
      const resultPath = path.join(histDir, "20260318T231054.result.json");
      fs.writeFileSync(resultPath, "{}");

      const result = inferSourcePath(resultPath);
      assert.equal(result, path.join(testsDir, "api.test.ts"));
    } finally {
      cleanup();
    }
  });

  it("history: returns undefined when source file doesn't exist", () => {
    const dir = setup();
    try {
      const histDir = path.join(dir, ".glubean", "results", "gone.test", "some-test");
      fs.mkdirSync(histDir, { recursive: true });
      const resultPath = path.join(histDir, "20260318T231054.result.json");
      fs.writeFileSync(resultPath, "{}");

      const result = inferSourcePath(resultPath);
      assert.equal(result, undefined);
    } finally {
      cleanup();
    }
  });

  it("non-result file: returns undefined for arbitrary .json", () => {
    const result = inferSourcePath("/some/path/config.json");
    assert.equal(result, undefined);
  });

  // ── Contract file support ───────────────────────────────────────────
  it("side-file: create.contract.result.json → create.contract.ts", () => {
    const dir = setup();
    try {
      fs.writeFileSync(path.join(dir, "create.contract.ts"), "");
      fs.writeFileSync(path.join(dir, "create.contract.result.json"), "{}");

      const result = inferSourcePath(path.join(dir, "create.contract.result.json"));
      assert.equal(result, path.join(dir, "create.contract.ts"));
    } finally {
      cleanup();
    }
  });

  it("history: .glubean/results/create.contract/create-project.success/ resolves contract source", () => {
    const dir = setup();
    try {
      // Create source file
      fs.writeFileSync(path.join(dir, "create.contract.ts"), "");

      // Create history structure
      const histDir = path.join(dir, ".glubean", "results", "create.contract", "create-project.success");
      fs.mkdirSync(histDir, { recursive: true });
      const resultPath = path.join(histDir, "20260411T120000.result.json");
      fs.writeFileSync(resultPath, "{}");

      const result = inferSourcePath(resultPath);
      assert.equal(result, path.join(dir, "create.contract.ts"));
    } finally {
      cleanup();
    }
  });
});
