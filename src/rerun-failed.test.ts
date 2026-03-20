/**
 * Tests for extractFailedTestIds — extracts failed test IDs from a result.
 *
 * Covers:
 * - null/undefined input → empty array
 * - empty tests array → empty array
 * - all pass → empty array
 * - mixed pass/fail → only failed IDs
 * - all fail → all IDs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFailedTestIds } from "./resultViewerUtils";

describe("extractFailedTestIds", () => {
  it("returns empty array for null input", () => {
    assert.deepStrictEqual(extractFailedTestIds(null), []);
  });

  it("returns empty array for undefined input", () => {
    assert.deepStrictEqual(extractFailedTestIds(undefined), []);
  });

  it("returns empty array when tests is not an array", () => {
    assert.deepStrictEqual(extractFailedTestIds({} as any), []);
  });

  it("returns empty array for empty tests array", () => {
    assert.deepStrictEqual(extractFailedTestIds({ tests: [] }), []);
  });

  it("returns empty array when all tests pass", () => {
    const result = {
      tests: [
        { testId: "health-check", success: true },
        { testId: "login-flow", success: true },
      ],
    };
    assert.deepStrictEqual(extractFailedTestIds(result), []);
  });

  it("returns only failed test IDs for mixed results", () => {
    const result = {
      tests: [
        { testId: "health-check", success: true },
        { testId: "login-flow", success: false },
        { testId: "search-api", success: true },
      ],
    };
    assert.deepStrictEqual(extractFailedTestIds(result), ["login-flow"]);
  });

  it("returns multiple failed IDs", () => {
    const result = {
      tests: [
        { testId: "health-check", success: true },
        { testId: "login-flow", success: false },
        { testId: "search-api", success: false },
      ],
    };
    assert.deepStrictEqual(extractFailedTestIds(result), [
      "login-flow",
      "search-api",
    ]);
  });

  it("returns all IDs when all tests fail", () => {
    const result = {
      tests: [
        { testId: "a", success: false },
        { testId: "b", success: false },
      ],
    };
    assert.deepStrictEqual(extractFailedTestIds(result), ["a", "b"]);
  });
});
