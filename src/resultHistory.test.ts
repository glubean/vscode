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
  resultHistoryDir,
  resultHistoryFileName,
  resultHistoryKey,
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
