/**
 * P0 regression tests for @glubean/runner generateSummary.
 *
 * These verify the summary derivation logic that the VSCode extension
 * relies on to display pass/fail status, assertion counts, and HTTP stats.
 *
 * Run with: npx tsx --test src/generate-summary.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { generateSummary } from "@glubean/runner";
import type { TimelineEvent } from "@glubean/runner";

// ---------------------------------------------------------------------------
// Scenario 1: all pass — trace(200) + assertion(passed=true)
// ---------------------------------------------------------------------------

describe("generateSummary", () => {
  it("all pass: trace(200) + assertion(passed=true) → success=true", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "GET", url: "https://api.example.com/health", status: 200, duration: 50 } as any },
      { type: "assertion", ts: 2, passed: true, message: "status is 200" },
    ];
    const s = generateSummary(events);
    assert.equal(s.success, true);
    assert.equal(s.assertionTotal, 1);
    assert.equal(s.assertionFailed, 0);
    assert.equal(s.httpRequestTotal, 1);
    assert.equal(s.httpErrorTotal, 0);
    assert.equal(s.httpErrorRate, 0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: soft fail — trace(200) + assertion(passed=false)
  // ---------------------------------------------------------------------------

  it("soft fail: trace(200) + assertion(passed=false) → success=false", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "GET", url: "https://api.example.com/users", status: 200, duration: 30 } as any },
      { type: "assertion", ts: 2, passed: false, message: "expected body.length > 0" },
    ];
    const s = generateSummary(events);
    assert.equal(s.success, false);
    assert.equal(s.assertionTotal, 1);
    assert.equal(s.assertionFailed, 1);
    assert.equal(s.httpRequestTotal, 1);
    assert.equal(s.httpErrorTotal, 0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: HTTP error — trace(500)
  // ---------------------------------------------------------------------------

  it("HTTP error: trace(500) → httpErrorTotal=1", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "POST", url: "https://api.example.com/crash", status: 500, duration: 200 } as any },
    ];
    const s = generateSummary(events);
    assert.equal(s.httpRequestTotal, 1);
    assert.equal(s.httpErrorTotal, 1);
    assert.equal(s.httpErrorRate, 1);
    // No assertions → success defaults to true (no assertion failures)
    assert.equal(s.success, true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: mixed — 3 traces + 2 assertions → correct counts
  // ---------------------------------------------------------------------------

  it("mixed: 3 traces + 2 assertions → correct counts", () => {
    const events: TimelineEvent[] = [
      { type: "trace", ts: 1, data: { method: "GET", url: "https://a.com", status: 200, duration: 10 } as any },
      { type: "trace", ts: 2, data: { method: "POST", url: "https://b.com", status: 201, duration: 20 } as any },
      { type: "trace", ts: 3, data: { method: "GET", url: "https://c.com", status: 404, duration: 15 } as any },
      { type: "assertion", ts: 4, passed: true, message: "status ok" },
      { type: "assertion", ts: 5, passed: true, message: "body ok" },
    ];
    const s = generateSummary(events);
    assert.equal(s.httpRequestTotal, 3);
    assert.equal(s.httpErrorTotal, 1); // 404 >= 400
    assert.equal(s.assertionTotal, 2);
    assert.equal(s.assertionFailed, 0);
    assert.equal(s.success, true);
    // httpErrorRate = 1/3 = 0.3333
    assert.equal(s.httpErrorRate, 0.3333);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: step test — step_end(passed) + step_end(failed) → success=false
  // ---------------------------------------------------------------------------

  it("step test: step_end(passed) + step_end(failed) → success=false", () => {
    const events: TimelineEvent[] = [
      {
        type: "step_end", ts: 1, index: 0, name: "login",
        status: "passed", durationMs: 100, assertions: 1, failedAssertions: 0,
      },
      {
        type: "step_end", ts: 2, index: 1, name: "get-profile",
        status: "failed", durationMs: 200, assertions: 1, failedAssertions: 1,
        error: "404 Not Found",
      },
    ];
    const s = generateSummary(events);
    assert.equal(s.success, false);
    assert.equal(s.stepTotal, 2);
    assert.equal(s.stepPassed, 1);
    assert.equal(s.stepFailed, 1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: empty events → success=true, all zero
  // ---------------------------------------------------------------------------

  it("empty events → success=true, all zero", () => {
    const s = generateSummary([]);
    assert.equal(s.success, true);
    assert.equal(s.assertionTotal, 0);
    assert.equal(s.assertionFailed, 0);
    assert.equal(s.httpRequestTotal, 0);
    assert.equal(s.httpErrorTotal, 0);
    assert.equal(s.httpErrorRate, 0);
    assert.equal(s.stepTotal, 0);
    assert.equal(s.stepPassed, 0);
    assert.equal(s.stepFailed, 0);
    assert.equal(s.stepSkipped, 0);
    assert.equal(s.warningTotal, 0);
    assert.equal(s.warningTriggered, 0);
    assert.equal(s.schemaValidationTotal, 0);
    assert.equal(s.schemaValidationFailed, 0);
    assert.equal(s.schemaValidationWarnings, 0);
  });
});
