/**
 * Tests for shared result-history path generation.
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractHistoryLabel,
  historyBaseName,
  resultHistoryDir,
  resultHistoryFileName,
  resultHistoryKey,
  resultHistoryRoot,
  sanitizePathSegment,
  sourceBaseName,
} from "./resultHistory";
import { writeRunArtifacts } from "./testController/artifacts";
import type { GlubeanResult } from "./testController/results";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glubean-result-history-"));
}

describe("resultHistory helpers", () => {
  it("normalizes data-driven IDs to a stable history key", () => {
    assert.equal(resultHistoryKey("pick:search-$_pick"), "search-");
    assert.equal(resultHistoryKey("each:item-$id"), "item-");
    assert.equal(resultHistoryKey("health-check"), "health-check");
  });

  it("builds readable filenames with optional pick labels", () => {
    assert.equal(resultHistoryFileName("20260318T231054"), "20260318T231054.result.json");
    assert.equal(
      resultHistoryFileName("20260318T230952", "by-name"),
      "20260318T230952[by-name].result.json",
    );
  });

  it("extracts labels from bracketed and legacy filenames", () => {
    assert.equal(extractHistoryLabel("20260318T230952[by-name].result.json"), "by-name");
    assert.equal(extractHistoryLabel("20260318T230952--by-name.result.json"), "by-name");
    assert.equal(extractHistoryLabel("20260318T230952.result.json"), undefined);
  });

  // -------------------------------------------------------------------------
  // P2: Additional result history scenarios
  // -------------------------------------------------------------------------

  it("sourceBaseName strips .ts extension", () => {
    assert.equal(sourceBaseName("/workspace/tests/health.test.ts"), "health.test");
  });

  it("sourceBaseName strips .js extension", () => {
    assert.equal(sourceBaseName("/workspace/tests/health.test.js"), "health.test");
  });

  it("sourceBaseName strips .mjs extension", () => {
    assert.equal(sourceBaseName("/workspace/tests/health.test.mjs"), "health.test");
  });

  it("sourceBaseName preserves non-source extensions", () => {
    assert.equal(sourceBaseName("/workspace/tests/health.test.json"), "health.test.json");
  });

  it("historyBaseName strips .result.json from result file", () => {
    assert.equal(historyBaseName("/workspace/tests/health.test.result.json"), "health.test");
  });

  it("historyBaseName strips source ext from source file", () => {
    assert.equal(historyBaseName("/workspace/tests/health.test.ts"), "health.test");
  });

  it("historyBaseName handles bare filename", () => {
    assert.equal(historyBaseName("search.test.ts"), "search.test");
  });

  it("sanitizePathSegment replaces invalid characters", () => {
    assert.equal(sanitizePathSegment("get-user/<id>"), "get-user__id_");
    assert.equal(sanitizePathSegment('foo"bar'), "foo_bar");
    assert.equal(sanitizePathSegment("a:b|c?d"), "a_b_c_d");
    assert.equal(sanitizePathSegment("normal-id"), "normal-id");
  });

  it("sanitizePathSegment replaces backslash and colon", () => {
    assert.equal(sanitizePathSegment("path\\to:file"), "path_to_file");
  });

  it("resultHistoryDir constructs complete path", () => {
    const dir = resultHistoryDir(
      "/workspace",
      "/workspace/tests/health.test.ts",
      "health-check",
    );
    assert.equal(
      dir,
      path.join("/workspace", ".glubean", "results", "health.test", "health-check"),
    );
  });

  it("resultHistoryDir normalizes data-driven IDs", () => {
    const dir = resultHistoryDir(
      "/workspace",
      "/workspace/tests/api.test.ts",
      "each:get-user-$id",
    );
    assert.equal(
      dir,
      path.join("/workspace", ".glubean", "results", "api.test", "get-user-"),
    );
  });

  it("resultHistoryRoot constructs root path", () => {
    const root = resultHistoryRoot(
      "/workspace",
      "/workspace/tests/health.test.ts",
    );
    assert.equal(
      root,
      path.join("/workspace", ".glubean", "results", "health.test"),
    );
  });

  it("extractHistoryLabel legacy --label format with multiple dashes", () => {
    assert.equal(
      extractHistoryLabel("20260318T230952--by-name-and-price.result.json"),
      "by-name-and-price",
    );
  });

  it("extractHistoryLabel returns undefined for timestamp-only stem", () => {
    assert.equal(extractHistoryLabel("20260318T230952.result.json"), undefined);
  });
});

describe("writeRunArtifacts", () => {
  it("writes plain history files for ordinary tests", () => {
    const cwd = makeTempWorkspace();
    tempDirs.push(cwd);

    const filePath = path.join(cwd, "tests", "health.test.ts");
    const resultJsonPath = path.join(cwd, "tests", "health.result.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const result: GlubeanResult = {
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 12 },
      tests: [
        {
          testId: "health-check",
          testName: "health-check",
          success: true,
          durationMs: 12,
          events: [],
        },
      ],
    };

    writeRunArtifacts(filePath, resultJsonPath, result, cwd);

    const dir = resultHistoryDir(cwd, filePath, "health-check");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}\.result\.json$/);
  });

  it("adds pick labels to pick history files", () => {
    const cwd = makeTempWorkspace();
    tempDirs.push(cwd);

    const filePath = path.join(cwd, "tests", "search.test.ts");
    const resultJsonPath = path.join(cwd, "tests", "search.result.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const result: GlubeanResult = {
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, durationMs: 20 },
      tests: [
        {
          testId: "search-",
          testName: "by-name",
          success: true,
          durationMs: 20,
          events: [],
        },
      ],
    };

    writeRunArtifacts(filePath, resultJsonPath, result, cwd, "by-name");

    const dir = resultHistoryDir(cwd, filePath, "search-");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}\[by-name\]\.result\.json$/);
  });
});
