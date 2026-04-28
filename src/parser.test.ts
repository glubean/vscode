/**
 * Tests for the Glubean test file parser.
 *
 * Run with: npx tsx --test src/parser.test.ts
 * (or use VS Code's built-in test runner)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractTests, isGlubeanFile } from "./parser";
import { extractPickExamples } from "@glubean/scanner/static";

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

  it("detects jsr and subpath SDK imports", () => {
    assert.equal(isGlubeanFile('import { test } from "jsr:@glubean/sdk@0.10.0";'), true);
    assert.equal(isGlubeanFile('import { getRegistry } from "@glubean/sdk/internal";'), true);
  });

  it("rejects files without SDK import", () => {
    assert.equal(isGlubeanFile('import { test } from "vitest";'), false);
    assert.equal(isGlubeanFile("const x = 1;"), false);
  });

  it("allows alias-based detection only when customFns are provided", () => {
    assert.equal(isGlubeanFile('import { browserTest } from "./configure.ts";'), false);
    assert.equal(isGlubeanFile('import { browserTest } from "./configure.ts";', ["browserTest"]), true);
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

  it("detects .pick on next line (chained after newline + generic)", () => {
    const content =
      SDK_IMPORT +
      `const scenarios = await fromDir.merge<OptScenario>("./data/optimize/");

export const optimizeSingapore = test
    .pick(scenarios)("optimize-sg-$_pick")
    .meta({ name: "Optimization Singapore", tags: ["api", "optimize"] })
    .setup(async (_ctx, row) => ({
      description: row.description,
      body: row.body,
    }))
    .use(withOptimization);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "optimize-sg-$_pick");
    assert.equal(picks[0].exportName, "optimizeSingapore");
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/optimize/",
    });
  });

  it("detects inline .pick on next line", () => {
    const content =
      SDK_IMPORT +
      `export const search = test
  .pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  "search-$_pick",
  async (ctx, data) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.deepEqual(picks[0].keys, ["by-name", "by-category"]);
    assert.equal(picks[0].testId, "search-$_pick");
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

  it("detects object ID form: test.pick(var)({ id: '...' }, ...)", () => {
    const content =
      SDK_IMPORT +
      `const cases = await fromDir.merge("./data/directions/");

export const directions = test.pick(cases)(
  { id: "directions-$_pick", name: "Directions: $_pick", tags: ["geo"] },
  async (ctx, { origin }) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "directions-$_pick");
    assert.equal(picks[0].exportName, "directions");
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/directions/",
    });
  });

  it("detects inline pick with object ID form", () => {
    const content =
      SDK_IMPORT +
      `export const search = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  { id: "search-$_pick", name: "Search: $_pick" },
  async (ctx, { q }) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "search-$_pick");
    assert.deepEqual(picks[0].keys, ["by-name", "by-category"]);
    assert.deepEqual(picks[0].dataSource, { type: "inline" });
  });
});

// ---------------------------------------------------------------------------
// test.each() with fromYaml / fromCsv data sources
// ---------------------------------------------------------------------------

describe("test.each() with data loaders", () => {
  it("handles fromYaml data source in test.each", () => {
    const content =
      SDK_IMPORT +
      `const rows = await fromYaml("./data/users.yaml");

export const userTests = test.each(rows)(
  {
    id: "user-$id",
    name: "User $name",
    tags: ["api"],
  },
  async (ctx, row) => {},
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:user-$id");
    assert.equal(tests[0].exportName, "userTests");
  });

  it("handles fromCsv data source in test.each", () => {
    const content =
      SDK_IMPORT +
      `const cases = await fromCsv("./data/test-cases.csv");

export const csvTests = test.each(cases)(
  "csv-case-$id",
  async (ctx, row) => {},
);`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:csv-case-$id");
    assert.equal(tests[0].name, "csv-case-$id (data-driven)");
    assert.equal(tests[0].exportName, "csvTests");
  });
});

// ---------------------------------------------------------------------------
// .test.js file content recognition
// ---------------------------------------------------------------------------

describe(".test.js file content", () => {
  it("detects ES import syntax in .js files", () => {
    const content = `import { test } from "@glubean/sdk";

export const health = test(
  { id: "health-check", name: "Health Check" },
  async (ctx) => {},
);`;

    assert.equal(isGlubeanFile(content), true);
    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "health-check");
  });

  it("does not detect require() syntax (CJS not supported by static parser)", () => {
    const content = `const { test } = require("@glubean/sdk");

exports.health = test(
  { id: "health-check", name: "Health Check" },
  async (ctx) => {},
);`;

    // CJS require is not recognized by the static parser
    assert.equal(isGlubeanFile(content), false);
    const tests = extractTests(content);
    assert.equal(tests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Multiline generic: fromDir.merge<Record<string, T>>(\n  "./data/"\n)
// ---------------------------------------------------------------------------

describe("multiline patterns", () => {
  it("fromDir.merge with nested generic loses dataSource (known limitation)", () => {
    // When a complex generic like Record<string, T> is present, the scanner
    // regex cannot match the path — the nested angle brackets confuse the
    // fromDir.merge pattern. The pick itself is still detected.
    const content =
      SDK_IMPORT +
      `const data = await fromDir.merge<Record<string, unknown>>("./data/products/");

export const prodTest = test.pick(data)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "prod-$_pick");
    // dataSource is undefined because nested generic breaks the regex
    assert.equal(picks[0].dataSource, undefined);
  });

  it("fromDir.merge with simple generic preserves dataSource", () => {
    // Simple single-level generics like <MyType> work fine
    const content =
      SDK_IMPORT +
      `const data = await fromDir.merge<ProductBody>("./data/products/");

export const prodTest = test.pick(data)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;

    const picks = extractPickExamples(content);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].testId, "prod-$_pick");
    assert.deepEqual(picks[0].dataSource, {
      type: "dir-merge",
      path: "./data/products/",
    });
  });

  it("handles test.each chained across lines with generic", () => {
    const content =
      SDK_IMPORT +
      `const scenarios = await fromYaml<Array<{
  id: string;
  description: string;
}>>("./data/scenarios.yaml");

export const scenarioTests = test
  .each(scenarios)({
    id: "scenario-$id",
    name: "$description",
  })
  .step("execute", async (ctx, _state, row) => {});`;

    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "each:scenario-$id");
    assert.equal(tests[0].exportName, "scenarioTests");
  });
});

// ---------------------------------------------------------------------------
// Contract file extraction
// ---------------------------------------------------------------------------

describe("extractTests — contract files", () => {
  const CONTRACT_IMPORT = 'import { contract } from "@glubean/sdk";\n';

  it("extracts contract cases from .contract.ts content", () => {
    const content = CONTRACT_IMPORT + `
import { api, publicHttp } from "../config/client.js";

export const createProject = contract.http("create-project", {
  endpoint: "POST /projects",
  client: api,
  cases: {
    success: {
      description: "Valid input returns 201.",
      body: { name: "Test" },
      expect: { status: 201 },
    },
    noAuth: {
      description: "Unauthenticated returns 401.",
      client: publicHttp,
      expect: { status: 401 },
    },
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].id, "create-project.success");
    assert.equal(tests[0].exportName, "createProject");
    assert.equal(tests[0].name, "POST /projects — success");
    assert.ok(tests[0].line > 0, "line number should be positive");
    assert.equal(tests[1].id, "create-project.noAuth");
  });

  it("returns empty array for contract file with no cases", () => {
    const content = CONTRACT_IMPORT + `export {};`;
    const tests = extractTests(content);
    assert.equal(tests.length, 0);
  });

  it("does not interfere with regular test files", () => {
    // A file with both test() and contract.http() — test() takes priority
    const content = `import { test, contract } from "@glubean/sdk";

export const smoke = test("smoke", (ctx) => { ctx.assert(true, "ok"); });

export const c = contract.http("my-contract", {
  endpoint: "GET /health",
  cases: { ok: { description: "200", expect: { status: 200 } } },
});
`;
    const tests = extractTests(content);
    // test() found first, so contract path never runs
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "smoke");
  });

  it("handles deferred and requires fields in contract cases", () => {
    const content = CONTRACT_IMPORT + `
export const auth = contract.http("auth-callback", {
  endpoint: "POST /auth/callback",
  cases: {
    real: {
      description: "Real OAuth.",
      requires: "browser",
      expect: { status: 200 },
    },
    deferred: {
      description: "Not ready.",
      deferred: "backend pending",
      expect: { status: 200 },
    },
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].id, "auth-callback.real");
    assert.equal(tests[1].id, "auth-callback.deferred");
  });
});

// ---------------------------------------------------------------------------
// // @contract marker-based discovery
// ---------------------------------------------------------------------------

describe("extractTests — // @contract marker", () => {
  const SDK_IMPORT = 'import { contract, configure } from "@glubean/sdk";\n';

  it("discovers contracts via // @contract marker with .with() syntax", () => {
    const content = SDK_IMPORT + `
const { http: api } = configure({ http: { prefixUrl: "{{API}}" } });
const userApi = contract.http.with("user", { client: api, security: "bearer" });

// @contract
export const getMe = userApi("get-me", {
  endpoint: "GET /me",
  cases: {
    ok: {
      description: "Returns profile",
      expect: { status: 200 },
    },
    unauthorized: {
      description: "Missing token",
      expect: { status: 401 },
    },
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].id, "get-me.ok");
    assert.equal(tests[0].exportName, "getMe");
    assert.equal(tests[0].name, "GET /me — ok");
    assert.ok(tests[0].line > 0);
    assert.equal(tests[1].id, "get-me.unauthorized");
    assert.equal(tests[1].exportName, "getMe");
  });

  it("discovers multiple contracts with separate markers", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("test", {});

// @contract
export const health = api("health", {
  endpoint: "GET /health",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});

// @contract
export const users = api("list-users", {
  endpoint: "GET /users",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
    empty: { description: "no users", expect: { status: 200 } },
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 3);
    assert.equal(tests[0].id, "health.ok");
    assert.equal(tests[0].exportName, "health");
    assert.equal(tests[1].id, "list-users.ok");
    assert.equal(tests[1].exportName, "users");
    assert.equal(tests[2].id, "list-users.empty");
  });

  it("ignores // @contract without a following export const", () => {
    const content = SDK_IMPORT + `
// @contract
const notExported = contract.http.with("x", {})("test", {
  endpoint: "GET /test",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 0);
  });

  it("falls back to old regex when no markers present", () => {
    const content = SDK_IMPORT + `
export const legacy = contract.http("legacy-test", {
  endpoint: "GET /legacy",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].id, "legacy-test.ok");
    assert.equal(tests[0].exportName, "legacy");
  });

  // Shorthand cases (defineHttpCase + variable references) — v10 canonical
  // pattern from cookbook contract-first/contracts/attachment-model/. Pre-fix
  // the parser only recognized inline `key: { ... }` and emitted ZERO
  // TestItems for shorthand-only contracts. Mirrors the contractLensCore
  // shorthand fix landed 2026-04-27.

  it("shorthand: cases referenced as variables produce one TestItem per case", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("dummyjson", {});
const authorized = defineHttpCase({ description: "ok", expect: { status: 200 } });
const requiresAttachment = defineHttpCase({ description: "blocked", expect: { status: 200 }, runnability: { requireAttachment: true } });

// @contract
export const getMe = api("auth.me", {
  endpoint: "GET /auth/me",
  cases: {
    authorized,
    requiresAttachment,
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].id, "auth.me.authorized");
    assert.equal(tests[0].exportName, "getMe");
    assert.equal(tests[0].name, "GET /auth/me — authorized");
    assert.equal(tests[1].id, "auth.me.requiresAttachment");
  });

  it("shorthand: trailing case without comma still captured", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("svc", {});
const a = defineHttpCase({ expect: { status: 200 } });
const b = defineHttpCase({ expect: { status: 200 } });

// @contract
export const ep = api("svc.ep", {
  endpoint: "GET /x",
  cases: {
    a,
    b
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    assert.equal(tests[0].id, "svc.ep.a");
    assert.equal(tests[1].id, "svc.ep.b");
  });

  it("mixed: inline + shorthand cases in one contract both produce TestItems", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("svc", {});
const archived = defineHttpCase({ expect: { status: 410 } });

// @contract
export const ep = api("svc.ep", {
  endpoint: "GET /x",
  cases: {
    fresh: {
      description: "fresh",
      expect: { status: 200 },
    },
    archived,
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 2);
    const ids = tests.map((t) => t.id).sort();
    assert.deepEqual(ids, ["svc.ep.archived", "svc.ep.fresh"]);
  });

  it("shorthand: case line points at the identifier line, not a comma or brace", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("svc", {});
const authorized = defineHttpCase({ expect: { status: 200 } });

// @contract
export const ep = api("svc.ep", {
  endpoint: "GET /x",
  cases: {
    authorized,
  },
});
`;
    const tests = extractTests(content);
    assert.equal(tests.length, 1);
    // Find the line with `    authorized,` in the content (1-based — parser line is 1-based).
    const lines = content.split("\n");
    const expectedLine = lines.findIndex((l) => l.trim() === "authorized,") + 1;
    assert.equal(tests[0].line, expectedLine);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap marker extraction (v10 attachment-model §7.4)
// ---------------------------------------------------------------------------

import { extractBootstrapMarkers, findImportPath, findContractIdInTarget } from "./parser";

describe("extractBootstrapMarkers", () => {
  it("extracts a single overlay export with simple targetIdent", () => {
    const content = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract.ts";

export const meAuthorizedOverlay = contract.bootstrap(
  getMe.case("authorized"),
  async (ctx) => ({ token: "tk" }),
);
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].exportName, "meAuthorizedOverlay");
    assert.equal(markers[0].targetIdent, "getMe");
    assert.equal(markers[0].caseKey, "authorized");
  });

  it("extracts multiple overlays in one file", () => {
    const content = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract.ts";

export const meAuthorizedOverlay = contract.bootstrap(
  getMe.case("authorized"),
  async () => ({ token: "a" }),
);

export const meAttachOverlay = contract.bootstrap(
  getMe.case("requiresAttachment"),
  { params: undefined as any, run: async () => ({ token: "b" }) },
);
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 2);
    const keys = markers.map((m) => m.caseKey).sort();
    assert.deepEqual(keys, ["authorized", "requiresAttachment"]);
  });

  it("attributes to the correct export when multiple `export const` are present", () => {
    // Bounded body window — bootstrap call in second export must not be
    // misattributed to the first.
    const content = `
import { getMe } from "./me.contract.ts";

export const meAuthorizedOverlay = contract.bootstrap(
  getMe.case("authorized"),
  async () => ({ token: "a" }),
);

export const helperConst = 42;

export const meSecondOverlay = contract.bootstrap(
  getMe.case("requiresAttachment"),
  async () => ({ token: "b" }),
);
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 2);
    assert.equal(markers[0].exportName, "meAuthorizedOverlay");
    assert.equal(markers[0].caseKey, "authorized");
    assert.equal(markers[1].exportName, "meSecondOverlay");
    assert.equal(markers[1].caseKey, "requiresAttachment");
  });

  it("handles multi-line contract.bootstrap() call form", () => {
    const content = `
import { getMe } from "./me.contract.ts";

export const meOverlay = contract
  .bootstrap(
    getMe.case("ok"),
    async (ctx) => ({}),
  );
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].targetIdent, "getMe");
    assert.equal(markers[0].caseKey, "ok");
  });

  it("returns empty for files with no contract.bootstrap() exports", () => {
    const content = `
import { contract } from "@glubean/sdk";
const api = contract.http.with("svc", {});
// @contract
export const ping = api("svc.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 0);
  });

  it("exportLine is 1-based (matches other detectors)", () => {
    const content = `
import { getMe } from "./me.contract.ts";

export const meOverlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({}),
);
`;
    const markers = extractBootstrapMarkers(content);
    assert.equal(markers.length, 1);
    // Line 4 in the literal (1: blank, 2: import, 3: blank, 4: export const)
    const lines = content.split("\n");
    const expected = lines.findIndex((l) => l.startsWith("export const meOverlay")) + 1;
    assert.equal(markers[0].exportLine, expected);
  });
});

describe("findImportPath", () => {
  it("returns path + originalName for a plain named import", () => {
    const content = `import { getMe } from "./me.contract.ts";`;
    const r = findImportPath(content, "getMe");
    assert.deepEqual(r, { path: "./me.contract.ts", originalName: "getMe" });
  });

  it("returns originalName when import uses `as` alias", () => {
    const content = `import { getMe as me } from "./me.contract.ts";`;
    const r = findImportPath(content, "me");
    assert.deepEqual(r, { path: "./me.contract.ts", originalName: "getMe" });
  });

  it("returns undefined when local ident is not imported", () => {
    const content = `import { other } from "./somewhere.ts";`;
    const r = findImportPath(content, "missing");
    assert.equal(r, undefined);
  });

  it("handles multi-line import block", () => {
    const content = `import {
  a,
  getMe,
  c,
} from "./me.contract.ts";`;
    const r = findImportPath(content, "getMe");
    assert.deepEqual(r, { path: "./me.contract.ts", originalName: "getMe" });
  });

  it("handles `import type` form", () => {
    const content = `import type { SchemaT } from "./types.ts";`;
    const r = findImportPath(content, "SchemaT");
    assert.deepEqual(r, { path: "./types.ts", originalName: "SchemaT" });
  });
});

describe("findContractIdInTarget", () => {
  it("extracts contractId from `export const NAME = factory(\"id\", { ... })`", () => {
    const content = `
const api = contract.http.with("dummyjson", {});

// @contract
export const getMe = api("auth.me", {
  endpoint: "GET /auth/me",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    assert.equal(findContractIdInTarget(content, "getMe"), "auth.me");
  });

  it("returns undefined when target export not found", () => {
    const content = `export const otherThing = something();`;
    assert.equal(findContractIdInTarget(content, "getMe"), undefined);
  });
});
