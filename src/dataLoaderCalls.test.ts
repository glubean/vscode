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

  // -------------------------------------------------------------------------
  // P2: Additional data loader scenarios
  // -------------------------------------------------------------------------

  it("resolves fromYaml single file path (bare)", () => {
    const content = `
const data = await fromYaml("data/users.yaml");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/users.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/data/users.yaml",
    }]);
  });

  it("resolves fromYaml with ./ relative path", () => {
    const content = `
const data = await fromYaml("./fixtures/config.yaml");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/config.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/tests/api/fixtures/config.yaml",
    }]);
  });

  it("resolves fromCsv single file path (bare)", () => {
    const content = `
const rows = await fromCsv("data/endpoints.csv");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/smoke.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/data/endpoints.csv",
    }]);
  });

  it("resolves fromCsv with ./ relative path", () => {
    const content = `
const rows = await fromCsv("./local/cases.csv");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/search.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/tests/api/local/cases.csv",
    }]);
  });

  it("resolves JSON import with ./ relative path", () => {
    const content = `
import fixtures from "./fixtures/data.json" with { type: "json" };
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/login.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "file",
      resolvedPath: "/workspace/tests/api/fixtures/data.json",
    }]);
  });

  it("resolves fromDir.concat path", () => {
    const content = `
const examples = await fromDir.concat("./data/products/");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/products.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "dir",
      resolvedPath: "/workspace/tests/api/data/products/",
    }]);
  });

  it("resolves fromDir.concat with bare path", () => {
    const content = `
const examples = await fromDir.concat("data/scenarios/");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/scenarios.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.deepEqual(calls, [{
      line: 1,
      target: "dir",
      resolvedPath: "/workspace/data/scenarios/",
    }]);
  });

  it("resolves path when on next line (multiline call)", () => {
    const content = `
const data = await fromYaml(
  "./data/users.yaml"
);
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/users.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, "file");
    assert.equal(calls[0].resolvedPath, "/workspace/tests/api/data/users.yaml");
  });

  it("resolves fromYaml with generic type parameter", () => {
    const content = `
const data = await fromYaml<UserRow>("data/users.yaml");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/users.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, "file");
    assert.equal(calls[0].resolvedPath, "/workspace/data/users.yaml");
  });

  it("resolves fromCsv with generic type parameter", () => {
    const content = `
const rows = await fromCsv<EndpointRow>("./data/endpoints.csv");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/endpoints.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, "file");
    assert.equal(calls[0].resolvedPath, "/workspace/tests/api/data/endpoints.csv");
  });

  it("resolves fromDir.merge with generic type parameter", () => {
    const content = `
const examples = await fromDir.merge<ProductBody>("./data/products/");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/products.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, "dir");
    assert.equal(calls[0].resolvedPath, "/workspace/tests/api/data/products/");
  });

  it("finds multiple data loader calls in one file", () => {
    const content = `
const users = await fromYaml("data/users.yaml");
const products = await fromCsv("./data/products.csv");
import config from "data/config.json" with { type: "json" };
const examples = await fromDir.merge("./data/examples/");
`;
    const calls = findDataLoaderCalls(content, {
      filePath: "/workspace/tests/api/combined.test.ts",
      workspaceRoot: "/workspace",
    });

    assert.equal(calls.length, 4);
    assert.equal(calls[0].target, "dir");   // fromDir.merge
    assert.equal(calls[1].target, "file");  // fromYaml
    assert.equal(calls[2].target, "file");  // fromCsv
    assert.equal(calls[3].target, "file");  // JSON import
  });
});
