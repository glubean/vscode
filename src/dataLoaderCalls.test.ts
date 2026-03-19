import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { findDataLoaderCalls } from "./dataLoaderCalls";

describe("findDataLoaderCalls", () => {
  it("resolves bare data paths from the workspace root", () => {
    const content = `
const rows = await fromCsv("data/cases.csv");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/cases.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/data/cases.csv",
    }]);
  });

  it("resolves ./ paths from the source file directory", () => {
    const content = `
const rows = await fromDir.merge("./data/cases/");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/cases.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "dir",
      resolvedPath: "/workspace/tests/api/data/cases/",
    }]);
  });

  it("resolves JSON imports with the same dual-mode rules", () => {
    const content = `
import examples from "data/examples.json" with { type: "json" };
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/examples.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/data/examples.json",
    }]);
  });
});
