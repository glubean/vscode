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
// detectRefactorScenarios — always returns all scenarios
// ---------------------------------------------------------------------------

describe("detectRefactorScenarios", () => {
  it("returns all 6 scenarios with copy-context first", () => {
    const content = SDK_IMPORT + `export const myTest = test("my-test", async () => {});`;
    const meta = makeMeta();
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.length, 6);
    assert.equal(scenarios[0].type, "copy-context");
  });

  it("returns all 6 scenarios for data-driven test", () => {
    const content = SDK_IMPORT + `export const myTest = test.each([])("t-$id", async () => {});`;
    const meta = makeMeta({ id: "each:t-$id" });
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.length, 6);
  });

  it("returns all 6 scenarios for metadata-object test", () => {
    const content = SDK_IMPORT + `export const myTest = test({ id: "my-test" }, async () => {});`;
    const meta = makeMeta();
    const scenarios = detectRefactorScenarios(content, "/project/tests/api.test.ts", meta);
    assert.equal(scenarios.length, 6);
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
  it("all prompts start with /glubean prefix", () => {
    const meta = makeMeta();
    const types = [
      "copy-context",
      "extract-data",
      "convert-to-pick",
      "promote-to-metadata",
      "extract-config",
      "promote-explore",
    ] as const;
    for (const type of types) {
      const prompt = buildPrompt(
        { type, label: "", detail: "" },
        "/project/tests/api.test.ts",
        meta,
      );
      assert.ok(prompt.startsWith("/glubean\n"), `${type} prompt must start with /glubean`);
    }
  });

  it("builds copy-context prompt with only context, no instructions", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "copy-context" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.startsWith("/glubean\n"));
    assert.ok(prompt.includes("**File:**"));
    assert.ok(prompt.includes("**Export:** myTest"));
    assert.ok(prompt.includes("**Test ID:** my-test"));
    assert.ok(!prompt.includes("## Instructions"), "copy-context must not have instructions");
    assert.ok(!prompt.includes("## Task"), "copy-context must not have task header");
  });

  it("builds extract-data prompt", () => {
    const meta = makeMeta({ id: "each:my-test-$id", exportName: "myTest" });
    const scenario = { type: "extract-data" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("Extract the inline test data"));
    assert.ok(prompt.includes("**File:**"));
    assert.ok(prompt.includes("**Export:** myTest"));
  });

  it("builds promote-explore prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "promote-explore" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/explore/api.test.ts", meta);

    assert.ok(prompt.includes("Promote"));
    assert.ok(prompt.includes("tests/"));
  });

  it("builds extract-config prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "extract-config" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("configure()"));
  });

  it("builds convert-to-pick prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "convert-to-pick" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("test.pick()"));
    assert.ok(prompt.includes("YAML data file"));
  });

  it("builds promote-to-metadata prompt", () => {
    const meta = makeMeta({ id: "my-test", exportName: "myTest" });
    const scenario = { type: "promote-to-metadata" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("metadata object"));
    assert.ok(prompt.includes("{ id:"));
  });

  it("strips variant prefix from test id in prompt", () => {
    const meta = makeMeta({ id: "pick:my-test-$_pick", exportName: "myTest" });
    const scenario = { type: "extract-data" as const, label: "", detail: "" };
    const prompt = buildPrompt(scenario, "/project/tests/api.test.ts", meta);

    assert.ok(prompt.includes("my-test-$_pick"));
    assert.ok(!prompt.includes("pick:my-test"));
  });
});
