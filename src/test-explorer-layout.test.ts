import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLayout, buildDirSegments } from "./testController/layout.js";

describe("resolveLayout", () => {
  it("flat mode always returns flat", () => {
    assert.equal(resolveLayout("flat", 5), "flat");
  });

  it("tree mode always returns tree", () => {
    assert.equal(resolveLayout("tree", 5), "tree");
  });

  it("auto mode with <=15 files returns flat", () => {
    assert.equal(resolveLayout("auto", 10), "flat");
  });

  it("auto mode with >15 files returns tree", () => {
    assert.equal(resolveLayout("auto", 20), "tree");
  });

  it("auto mode with exactly 15 files returns flat", () => {
    assert.equal(resolveLayout("auto", 15), "flat");
  });

  it("auto mode with 16 files returns tree", () => {
    assert.equal(resolveLayout("auto", 16), "tree");
  });
});

describe("buildDirSegments", () => {
  it("explore with one directory level", () => {
    assert.deepEqual(
      buildDirSegments("explore/dummyjson/smoke.test.ts", "explore"),
      ["dummyjson"],
    );
  });

  it("explore with two directory levels", () => {
    assert.deepEqual(
      buildDirSegments("explore/github/smoke/public.test.ts", "explore"),
      ["github", "smoke"],
    );
  });

  it("tests root-level file returns empty segments", () => {
    assert.deepEqual(
      buildDirSegments("tests/smoke.test.ts", "tests"),
      [],
    );
  });

  it("tests with one directory level", () => {
    assert.deepEqual(
      buildDirSegments("tests/api/users.test.ts", "tests"),
      ["api"],
    );
  });

  it("handles backslash separators", () => {
    assert.deepEqual(
      buildDirSegments("explore\\github\\smoke.test.ts", "explore"),
      ["github"],
    );
  });
});
