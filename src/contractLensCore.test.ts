/**
 * Unit tests for contract CodeLens computation.
 *
 * Run with: npx tsx --test src/contractLensCore.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeContractLenses } from "./contractLensCore";

const CONTRACT_IMPORT = 'import { contract } from "@glubean/sdk";\n';
const FILE_PATH = "/tmp/create.contract.ts";

describe("computeContractLenses", () => {
  it("emits one run item per regular case", () => {
    const content = CONTRACT_IMPORT + `
export const createProject = contract.http("create-project", {
  endpoint: "POST /projects",
  cases: {
    success: {
      description: "Valid input returns 201.",
      expect: { status: 201 },
    },
    notFound: {
      description: "Missing resource returns 404.",
      expect: { status: 404 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);

    assert.equal(items[0].kind, "run");
    assert.equal(items[0].title, "\u25B6 run success");
    assert.deepEqual(items[0].args, {
      filePath: FILE_PATH,
      testId: "create-project.success",
      exportName: "createProject",
    });

    assert.equal(items[1].kind, "run");
    assert.equal(items[1].title, "\u25B6 run notFound");
    assert.equal(items[1].args?.testId, "create-project.notFound");
  });

  it("emits disabled item for deferred case", () => {
    const content = CONTRACT_IMPORT + `
export const c = contract.http("my-contract", {
  endpoint: "GET /x",
  cases: {
    later: {
      description: "Not yet.",
      deferred: "backend not ready",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.equal(items[0].title, "\u2298 deferred: backend not ready");
    assert.equal(items[0].args, undefined);
  });

  it("emits disabled item for requires: browser", () => {
    const content = CONTRACT_IMPORT + `
export const c = contract.http("auth", {
  endpoint: "POST /auth",
  cases: {
    real: {
      description: "Real OAuth.",
      requires: "browser",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.equal(items[0].title, "\u2298 requires: browser");
    assert.equal(items[0].args, undefined);
  });

  it("emits disabled item for requires: out-of-band", () => {
    const content = CONTRACT_IMPORT + `
export const c = contract.http("sms", {
  endpoint: "POST /sms",
  cases: {
    delivery: {
      description: "Real SMS.",
      requires: "out-of-band",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.equal(items[0].title, "\u2298 requires: out-of-band");
  });

  it("labels opt-in cases with (opt-in) suffix but keeps them runnable", () => {
    const content = CONTRACT_IMPORT + `
export const c = contract.http("stripe", {
  endpoint: "POST /charge",
  cases: {
    liveCharge: {
      description: "Real charge.",
      defaultRun: "opt-in",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].title, "\u25B6 run liveCharge (opt-in)");
    assert.equal(items[0].args?.testId, "stripe.liveCharge");
  });

  it("places each case at its own 0-based line", () => {
    // line 1: import
    // line 2: blank
    // line 3: export const
    // line 4: endpoint
    // line 5: cases: {
    // line 6: a: {   ← case key
    const content = CONTRACT_IMPORT + `
export const c = contract.http("my", {
  endpoint: "GET /",
  cases: {
    a: { description: "first", expect: { status: 200 } },
    b: { description: "second", expect: { status: 200 } },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    // Both should be at distinct, positive (0-based) lines
    assert.ok(items[0].line >= 0);
    assert.ok(items[1].line > items[0].line, "second case should be on a later line");
  });

  it("returns empty array when there are no contracts", () => {
    const content = 'import { test } from "@glubean/sdk";\nexport const x = test("y", () => {});';
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 0);
  });

  it("handles multiple contracts in one file", () => {
    const content = CONTRACT_IMPORT + `
export const a = contract.http("a-contract", {
  endpoint: "GET /a",
  cases: {
    one: { description: "a one", expect: { status: 200 } },
  },
});

export const b = contract.http("b-contract", {
  endpoint: "GET /b",
  cases: {
    two: { description: "b two", expect: { status: 200 } },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    assert.equal(items[0].args?.testId, "a-contract.one");
    assert.equal(items[0].args?.exportName, "a");
    assert.equal(items[1].args?.testId, "b-contract.two");
    assert.equal(items[1].args?.exportName, "b");
  });

  it("mixes disabled and runnable items correctly", () => {
    const content = CONTRACT_IMPORT + `
export const c = contract.http("mixed", {
  endpoint: "POST /x",
  cases: {
    runnable: {
      description: "Normal.",
      expect: { status: 200 },
    },
    later: {
      description: "Deferred.",
      deferred: "TODO",
      expect: { status: 200 },
    },
    browserOnly: {
      description: "Browser.",
      requires: "browser",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 3);
    assert.equal(items[0].kind, "run");
    assert.equal(items[1].kind, "disabled");
    assert.equal(items[2].kind, "disabled");
  });
});

// ---------------------------------------------------------------------------
// // @contract marker-based CodeLens
// ---------------------------------------------------------------------------

describe("computeContractLenses — // @contract marker", () => {
  const SDK_IMPORT = 'import { contract, configure } from "@glubean/sdk";\n';

  it("emits run items for marker-based .with() contracts", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("test", {});

// @contract
export const getMe = api("get-me", {
  endpoint: "GET /me",
  cases: {
    ok: {
      description: "Returns profile",
      expect: { status: 200 },
    },
    notFound: {
      description: "User not found",
      expect: { status: 404 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].title, "▶ run ok");
    assert.equal(items[0].args?.testId, "get-me.ok");
    assert.equal(items[0].args?.exportName, "getMe");
    assert.equal(items[1].kind, "run");
    assert.equal(items[1].title, "▶ run notFound");
    assert.equal(items[1].args?.testId, "get-me.notFound");
  });

  it("handles deferred cases with marker", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("test", {});

// @contract
export const send = api("send", {
  endpoint: "POST /send",
  cases: {
    ok: {
      description: "Sent",
      expect: { status: 201 },
    },
    pending: {
      description: "Not ready",
      deferred: "backend pending",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "run");
    assert.equal(items[1].kind, "disabled");
    assert.ok(items[1].title.includes("deferred: backend pending"));
  });

  it("handles requires: browser with marker", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("test", {});

// @contract
export const oauth = api("oauth", {
  endpoint: "POST /oauth/callback",
  cases: {
    real: {
      description: "Real OAuth",
      requires: "browser",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.ok(items[0].title.includes("requires: browser"));
  });

  it("falls back to old regex when no markers present", () => {
    const content = CONTRACT_IMPORT + `
export const legacy = contract.http("legacy", {
  endpoint: "GET /legacy",
  cases: {
    ok: { description: "ok", expect: { status: 200 } },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].args?.testId, "legacy.ok");
  });
});
