/**
 * Tests for the Glubean test file parser.
 *
 * Run with: npx tsx --test src/parser.test.ts
 * (or use VS Code's built-in test runner)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractPickExamples, extractTests, isGlubeanFile } from "./parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SDK_IMPORT = 'import { test } from "@glubean/sdk";\n\n';

// ---------------------------------------------------------------------------
// isGlubeanFile
// ---------------------------------------------------------------------------

describe("isGlubeanFile", () => {
  it("detects @glubean/sdk import", () => {
    assert.equal(isGlubeanFile('import { test } from "@glubean/sdk";'), true);
  });

  it("detects jsr:@glubean/sdk import", () => {
    assert.equal(
      isGlubeanFile('import { test } from "jsr:@glubean/sdk";'),
      true,
    );
  });

  it("detects jsr:@glubean/sdk@version import", () => {
    assert.equal(
      isGlubeanFile('import { test } from "jsr:@glubean/sdk@0.5.0";'),
      true,
    );
  });

  it("rejects files without SDK import", () => {
    assert.equal(isGlubeanFile('import { test } from "vitest";'), false);
    assert.equal(isGlubeanFile("const x = 1;"), false);
  });
});

// ---------------------------------------------------------------------------
// test() with object metadata
// ---------------------------------------------------------------------------

describe("test() with object metadata", () => {
  it("extracts id, name, tags", () => {
    const content =
      SDK_IMPORT +
      `export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke"] },
  async (ctx) => {}
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "list-products");
    assert.equal(tests[0].name, "List Products");
    assert.deepEqual(tests[0].tags, ["smoke"]);
    assert.equal(tests[0].exportName, "listProducts");
    assert.equal(tests[0].type, "test");
    assert.equal(tests[0].line, 3); // line of `export const`
  });

  it("skips tests without id in meta object", () => {
    // Scanner requires an explicit `id` field — tests without one are skipped.
    // This matches the SDK contract: TestMeta requires `id`.
    const content =
      SDK_IMPORT +
      `export const myTest = test(
  { name: "My Test" },
  async (ctx) => {}
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// test() with string ID (builder pattern)
// ---------------------------------------------------------------------------

describe("test() builder pattern", () => {
  it("extracts string id", () => {
    const content =
      SDK_IMPORT +
      `export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {})
  .step("get profile", async (ctx, state) => {})
  .step("refresh token", async (ctx, state) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "auth-flow");
    assert.equal(tests[0].name, "Authentication Flow");
    assert.deepEqual(tests[0].tags, ["auth"]);
    assert.deepEqual(tests[0].steps, ["login", "get profile", "refresh token"]);
  });

  it("extracts id without .meta()", () => {
    const content =
      SDK_IMPORT +
      `export const simple = test("simple-test")
  .step("do something", async (ctx) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "simple-test");
    assert.equal(tests[0].name, "simple-test"); // fallback to id
    assert.deepEqual(tests[0].steps, ["do something"]);
  });
});

// ---------------------------------------------------------------------------
// test.each()
// ---------------------------------------------------------------------------

describe("test.each()", () => {
  it("extracts pattern as group (string ID)", () => {
    const content =
      SDK_IMPORT +
      `export const tests = test.each(cases)("case-$id", async (ctx, row) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:case-$id");
    assert.equal(tests[0].name, "case-$id (data-driven)");
  });

  it("extracts pattern with object metadata", () => {
    const content =
      SDK_IMPORT +
      `export const userTests = test.each(users)(
  {
    id: "get-user-$id",
    name: "GET /users/$id",
    tags: "smoke",
  },
  async (ctx, { id }) => {},
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:get-user-$id");
    assert.equal(tests[0].exportName, "userTests");
  });

  it("handles nested function calls in data arg", () => {
    const content =
      SDK_IMPORT +
      `export const endpointTests = test.each(await fromCsv("./data/endpoints.csv"))(
  {
    id: "endpoint-$method-$path",
    name: "$method $path",
  },
  async (ctx, row) => {},
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:endpoint-$method-$path");
    assert.equal(tests[0].exportName, "endpointTests");
  });

  it("handles deeply nested calls in data arg", () => {
    const content =
      SDK_IMPORT +
      `export const scenarioTests = test
  .each(await fromYaml("./data/scenarios.yaml"))({
    id: "scenario-$id",
    name: "$description",
  })
  .step("send request", async (ctx, _state, row) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:scenario-$id");
    assert.equal(tests[0].exportName, "scenarioTests");
  });
});

// ---------------------------------------------------------------------------
// Multiple tests in one file
// ---------------------------------------------------------------------------

describe("multiple tests", () => {
  it("extracts all tests from demo.test.ts-like content", () => {
    const content =
      SDK_IMPORT +
      `export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke"] },
  async (ctx) => {}
);

export const searchProducts = test(
  { id: "search-products", name: "Search Products", tags: ["smoke"] },
  async (ctx) => {}
);

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {})
  .step("get profile", async (ctx, state) => {})
  .step("refresh token", async (ctx, state) => {});

export const cartIntegrity = test(
  { id: "cart-integrity", name: "Cart Data Integrity", tags: ["data-integrity"] },
  async (ctx) => {}
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 4);

    const ids = new Set(tests.map((t) => t.id));
    assert.deepEqual(
      ids,
      new Set([
        "list-products",
        "search-products",
        "auth-flow",
        "cart-integrity",
      ]),
    );
  });

  it("deduplicates by id", () => {
    const content =
      SDK_IMPORT +
      `export const a = test({ id: "same-id" }, async (ctx) => {});
export const b = test({ id: "same-id" }, async (ctx) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Guard: non-glubean files
// ---------------------------------------------------------------------------

describe("non-glubean files", () => {
  it("returns empty for files without SDK import", () => {
    const content = `export const foo = test("bar", () => {});`;
    const tests = extractTests(content);
    assert.equal(tests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// extractPickExamples — dir-merge support
// ---------------------------------------------------------------------------

describe("extractPickExamples", () => {
  it("detects fromDir.merge with literal path", () => {
    const content =
      SDK_IMPORT +
      `const examples = await fromDir.merge("./data/add-product/");

export const addProduct = test.pick(examples)(
  "add-product-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "add-product-$_pick");
    assert.equal(picks[0].exportName, "addProduct");
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/add-product/",
    });
    assert.equal(picks[0].keys, null);
  });

  it("detects fromDir.merge with options object", () => {
    const content =
      SDK_IMPORT +
      `const specs = await fromDir.merge("./data/specs/", { ext: ".yaml" });

export const specTest = test.pick(specs)(
  "spec-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/specs/",
    });
  });

  it("returns undefined dataSource for non-literal fromDir.merge path", () => {
    const content =
      SDK_IMPORT +
      `const dir = vars.require("DATA_DIR");
const examples = await fromDir.merge(dir);

export const dynTest = test.pick(examples)(
  "dyn-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].dataSource, undefined);
    assert.equal(picks[0].keys, null);
  });

  it("still detects inline object patterns", () => {
    const content =
      SDK_IMPORT +
      `export const search = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  "search-$_pick",
  async (ctx, data) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.deepEqual(picks[0].keys, ["by-name", "by-category"]);
    assert.deepEqual(picks[0].dataSource, { type: "inline" });
  });

  it("still detects JSON import patterns", () => {
    const content =
      SDK_IMPORT +
      `import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.deepEqual(picks[0].dataSource, {
      type: "json-import",
      path: "../data/create-user.json",
    });
  });

  it("handles let declarations for fromDir.merge", () => {
    const content =
      SDK_IMPORT +
      `let data = await fromDir.merge("./data/products/");

export const prodTest = test.pick(data)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/products/",
    });
  });
});
