/**
 * Tests for AI Refactor scenario detection and prompt building.
 *
 * Run with: npx tsx --test src/aiRefactor.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  countInlineCases,
  hasRepeatedUrls,
  detectRefactorScenarios,
  buildPrompt,
  extractExportBlock,
} from "./aiRefactorCore";
import type { TestMeta } from "./parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SDK_IMPORT = 'import { test } from "@glubean/sdk";\n\n';

function makeMeta(overrides: Partial<TestMeta> = {}): TestMeta {
  return {
    type: "test",
    id: "my-test",
    exportName: "myTest",
    line: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// countInlineCases
// ---------------------------------------------------------------------------

describe("countInlineCases", () => {
  it("counts keys in test.each inline object", () => {
    const content = SDK_IMPORT + `export const myTest = test.each({
  "case-1": { url: "/a" },
  "case-2": { url: "/b" },
  "case-3": { url: "/c" },
  "case-4": { url: "/d" },
})("my-test-$id", async (ctx, data) => {});`;
    assert.equal(countInlineCases(content, "myTest"), 4);
  });

  it("counts keys in test.pick inline object", () => {
    const content = SDK_IMPORT + `export const myTest = test.pick({
  alpha: { url: "/a" },
  beta: { url: "/b" },
})("my-test-$_pick", async (ctx, data) => {});`;
    assert.equal(countInlineCases(content, "myTest"), 2);
  });

  it("returns 0 for non-matching export name", () => {
    const content = SDK_IMPORT + `export const other = test.each({
  "a": {}, "b": {}, "c": {}, "d": {},
})("other-$id", async () => {});`;
    assert.equal(countInlineCases(content, "myTest"), 0);
  });

  it("counts elements in test.each inline array", () => {
    const content = SDK_IMPORT + `export const myTest = test.each([
  { q: "phone", min: 1 },
  { q: "laptop", min: 5 },
  { q: "tablet", min: 3 },
  { q: "headphones", min: 2 },
])("search-$q", async (ctx, data) => {});`;
    assert.equal(countInlineCases(content, "myTest"), 4);
  });

  it("returns 0 when data is a variable reference", () => {
    const content = SDK_IMPORT + `export const myTest = test.pick(data)("my-test-$_pick", async () => {});`;
    assert.equal(countInlineCases(content, "myTest"), 0);
  });

  it("counts unquoted keys", () => {
    const content = SDK_IMPORT + `export const myTest = test.each({
  alpha: { url: "/a" },
  beta: { url: "/b" },
  gamma: { url: "/c" },
  delta: { url: "/d" },
})("my-test-$id", async () => {});`;
    assert.equal(countInlineCases(content, "myTest"), 4);
  });
});

// ---------------------------------------------------------------------------
// hasRepeatedUrls
// ---------------------------------------------------------------------------

describe("hasRepeatedUrls", () => {
  it("returns true when same URL appears twice", () => {
    const content = `
      const a = "https://api.example.com/users";
      const b = "https://api.example.com/users";
    `;
    assert.equal(hasRepeatedUrls(content), true);
  });

  it("returns false when all URLs are unique", () => {
    const content = `
      const a = "https://api.example.com/users";
      const b = "https://api.example.com/posts";
    `;
    assert.equal(hasRepeatedUrls(content), false);
  });

  it("returns false when no URLs present", () => {
    assert.equal(hasRepeatedUrls("const x = 42;"), false);
  });

  it("returns false with single URL", () => {
    const content = `const a = "https://api.example.com/users";`;
    assert.equal(hasRepeatedUrls(content), false);
  });
});

// ---------------------------------------------------------------------------
// detectRefactorScenarios
// ---------------------------------------------------------------------------

describe("detectRefactorScenarios", () => {
  it("detects extract-data when inline cases > 3", () => {
    const content = SDK_IMPORT + `export const myTest = test.each({
  "a": {}, "b": {}, "c": {}, "d": {},
})("my-test-$id", async () => {});`;
    const meta = makeMeta({ id: "each:my-test-$id", exportName: "myTest" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "extract-data"), true);
  });

  it("does not detect extract-data when inline cases <= 3", () => {
    const content = SDK_IMPORT + `export const myTest = test.each({
  "a": {}, "b": {},
})("my-test-$id", async () => {});`;
    const meta = makeMeta({ id: "each:my-test-$id", exportName: "myTest" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "extract-data"), false);
  });

  it("does not detect extract-data for non-data-driven tests", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async () => {});`;
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "extract-data"), false);
  });

  it("detects promote-explore for files in explore/", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async () => {});`;
    const meta = makeMeta();
    const scenarios = detectRefactorScenarios(content, "/project/explore/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "promote-explore"), true);
  });

  it("does not detect promote-explore for files in tests/", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async () => {});`;
    const meta = makeMeta();
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "promote-explore"), false);
  });

  it("detects extract-config when URLs are repeated", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async (ctx) => {
  await ctx.http.get("https://api.example.com/users");
  await ctx.http.get("https://api.example.com/users");
});`;
    const meta = makeMeta();
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "extract-config"), true);
  });

  it("detects extract-config for chained data-driven tests", () => {
    const content = SDK_IMPORT + `export const myTest = test.each([
  { url: "https://api.example.com/users" },
  { url: "https://api.example.com/users" },
  { url: "https://api.example.com/users" },
  { url: "https://api.example.com/users" },
])("my-test-$id", async (ctx, data) => {
  await ctx.http.get(data.url);
  await ctx.http.get(data.url);
});`;
    const meta = makeMeta({ id: "each:my-test-$id", exportName: "myTest" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    const types = scenarios.map((s) => s.type).sort();
    assert.deepEqual(types, ["extract-config", "extract-data"]);
  });

  it("detects multiple scenarios simultaneously", () => {
    // extract-config needs repeated URLs within the export block — use a simple test (not chained .each)
    const content = SDK_IMPORT + `export const myTest = test("my-test", async (ctx) => {
  await ctx.http.get("https://api.example.com/users");
  await ctx.http.get("https://api.example.com/users");
});

export const dataTest = test.each({
  "a": {}, "b": {}, "c": {}, "d": {},
})("data-$id", async () => {});`;
    // Test myTest in explore/ → promote-explore + extract-config
    const meta1 = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenarios1 = detectRefactorScenarios(content, "/project/explore/api.test.ts", meta1);
    assert.equal(scenarios1.length, 2);
    const types1 = scenarios1.map((s) => s.type).sort();
    assert.deepEqual(types1, ["extract-config", "promote-explore"]);

    // Test dataTest in explore/ → extract-data + promote-explore
    const meta2 = makeMeta({ id: "each:data-$id", exportName: "dataTest" });
    const scenarios2 = detectRefactorScenarios(content, "/project/explore/api.test.ts", meta2);
    assert.equal(scenarios2.length, 2);
    const types2 = scenarios2.map((s) => s.type).sort();
    assert.deepEqual(types2, ["extract-data", "promote-explore"]);
  });

  it("does not detect extract-config from another export in the same file", () => {
    const content = SDK_IMPORT + `export const first = test("first", async (ctx) => {
  await ctx.http.get("/users");
});

export const second = test("second", async (ctx) => {
  await ctx.http.get("https://api.example.com/orders");
  await ctx.http.get("https://api.example.com/orders");
});`;
    const meta = makeMeta({ id: "first", exportName: "first" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.some((s) => s.type === "extract-config"), false);
  });
});

// ---------------------------------------------------------------------------
// extractExportBlock
// ---------------------------------------------------------------------------

describe("extractExportBlock", () => {
  it("extracts a simple test export", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async (ctx) => {
  const res = await ctx.http.get("/api");
});`;
    const block = extractExportBlock(content, "myTest");
    assert.ok(block.startsWith("export const myTest"));
    assert.ok(block.includes("ctx.http.get"));
  });

  it("extracts chained data-driven exports through the test body", () => {
    const content = SDK_IMPORT + `export const myTest = test.each([
  { url: "https://api.example.com/users" },
  { url: "https://api.example.com/users" },
])("my-test-$id", async (ctx, data) => {
  await ctx.http.get(data.url);
  await ctx.http.get(data.url);
});`;
    const block = extractExportBlock(content, "myTest");
    assert.ok(block.includes('await ctx.http.get(data.url);'));
    assert.ok(block.endsWith("});"));
  });

  it("returns empty string for missing export", () => {
    const content = SDK_IMPORT + `export const other = test("other", async () => {});`;
    assert.equal(extractExportBlock(content, "myTest"), "");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  const sampleContent = SDK_IMPORT + `export const myTest = test.each({
  "a": { url: "/a" },
  "b": { url: "/b" },
  "c": { url: "/c" },
  "d": { url: "/d" },
})("my-test-$id", async (ctx, data) => {
  await ctx.http.get(data.url);
});`;

  it("builds extract-data prompt with correct sections", () => {
    const meta = makeMeta({ id: "each:my-test-$id", exportName: "myTest" });
    const scenario = { type: "extract-data" as const, label: "Extract inline data", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("## Task"));
    assert.ok(prompt.includes("Extract the inline test data"));
    assert.ok(prompt.includes("**File:**"));
    assert.ok(prompt.includes("/project/tests/api.test.ts"));
    assert.ok(prompt.includes("**Export:** myTest"));
    assert.ok(prompt.includes("## Instructions"));
    assert.ok(prompt.includes("single YAML data file"));
    assert.ok(prompt.includes("load it with `fromYaml`"));
    // Slim format — no Project Context or Glubean Conventions sections
    assert.ok(!prompt.includes("## Project Context"));
    assert.ok(!prompt.includes("## Glubean Conventions"));
  });

  it("builds promote-explore prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "promote-explore" as const, label: "Promote", detail: "" };
    const prompt = buildPrompt(scenario, "/project/explore/api.test.ts", meta);

    assert.ok(prompt.includes("Promote"));
    assert.ok(prompt.includes("explore/"));
    assert.ok(prompt.includes("tests/"));
  });

  it("builds extract-config prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "extract-config" as const, label: "Extract config", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("configure()"));
    assert.ok(prompt.includes("base URL"));
  });

  it("strips variant prefix from test id in prompt", () => {
    const meta = makeMeta({ id: "pick:my-test-$_pick", exportName: "myTest" });
    const scenario = { type: "extract-data" as const, label: "Extract", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("my-test-$_pick"));
    assert.ok(!prompt.includes("pick:my-test"));
  });
});
