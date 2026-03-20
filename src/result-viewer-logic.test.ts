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
import { deriveSuccess, extractAssertions, extractTraceCalls } from "./webview/result-utils";
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
