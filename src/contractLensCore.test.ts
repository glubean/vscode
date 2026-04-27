/**
 * Unit tests for contract CodeLens computation.
 *
 * Run with: npx tsx --test src/contractLensCore.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  computeContractLenses,
  CONTRACT_LENS_FILE_PATTERNS,
} from "./contractLensCore";

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

  it("handles deprecated cases with marker", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("test", {});

// @contract
export const legacy = api("legacy", {
  endpoint: "POST /v1/legacy",
  cases: {
    old: {
      description: "v1 path",
      deprecated: "use v2",
      expect: { status: 200 },
    },
  },
});
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.ok(items[0].title.includes("deprecated: use v2"));
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

  // ── Shorthand cases (defineHttpCase + variable references) ────────────
  // The canonical attachment-model v10 pattern: cases bound as
  // `defineHttpCase<{ token: string }>(...)` outside the contract literal,
  // then referenced via shorthand property syntax inside the `cases` block.
  // Pre-fix the parser only recognized inline `key: { ... }` shape and
  // emitted ZERO lenses for shorthand-only contracts. Now we walk segment
  // boundaries (commas + closing brace) and treat bare-identifier segments
  // as shorthand cases.

  it("shorthand: cases referenced as variables produce one lens per case", () => {
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
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].args?.testId, "auth.me.authorized");
    assert.equal(items[0].args?.exportName, "getMe");
    assert.equal(items[1].kind, "run");
    assert.equal(items[1].args?.testId, "auth.me.requiresAttachment");
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
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    assert.equal(items[0].args?.testId, "svc.ep.a");
    assert.equal(items[1].args?.testId, "svc.ep.b");
  });

  it("mixed: inline + shorthand cases in one contract both produce lenses", () => {
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
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 2);
    const titles = items.map((i) => i.title).sort();
    assert.deepEqual(titles, ["▶ run archived", "▶ run fresh"]);
    const ids = items.map((i) => i.args?.testId).sort();
    assert.deepEqual(ids, ["svc.ep.archived", "svc.ep.fresh"]);
  });

  it("shorthand: case key offset points at the identifier line, not the comma", () => {
    // Lens line should be the line containing the identifier, so the
    // ▶ button shows up on the same row as `authorized,` rather than on
    // the comma's preceding-line empty whitespace.
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
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    // Find the line index of `    authorized,` in the content (0-based).
    const lines = content.split("\n");
    const expectedLine = lines.findIndex((l) => l.trim() === "authorized,");
    assert.equal(items[0].line, expectedLine, "lens must render on the identifier's own line");
  });
});

// ---------------------------------------------------------------------------
// // @flow marker-based CodeLens
// ---------------------------------------------------------------------------

describe("computeContractLenses — // @flow marker", () => {
  const FILE_PATH = "/abs/path/to/flow.contract.ts";
  const SDK_IMPORT = 'import { contract, configure } from "@glubean/sdk";\n';

  it("emits a single run item for a flow with a literal id", () => {
    const content = SDK_IMPORT + `
import { login } from "./auth.contract.ts";
import { getProfile } from "./profile.contract.ts";

// @flow
export const loginThenGetProfile = contract
  .flow("login-then-profile")
  .meta({ description: "E2E", tags: ["e2e"] })
  .step(login.case("success"), {
    out: (_s, res: any) => ({ token: res.body.accessToken }),
  })
  .compute((s) => ({ ...s, authHeader: \`Bearer \${s.token}\` }))
  .step(getProfile.case("authorized"), {
    in: (s) => ({ headers: { Authorization: s.authHeader } }),
  });
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].title, "▶ run login-then-profile");
    assert.equal(items[0].args?.testId, "login-then-profile");
    assert.equal(items[0].args?.exportName, "loginThenGetProfile");
    // Lens should sit on the `export const` line (0-based).
    // Count lines up to `export const loginThenGetProfile` in the content.
    const expectedLine = content.split("\n").findIndex((l) =>
      l.includes("export const loginThenGetProfile")
    );
    assert.equal(items[0].line, expectedLine);
  });

  it("emits a disabled item when flow is marked skip via .meta({ skip: \"...\" })", () => {
    const content = SDK_IMPORT + `
// @flow
export const illustrative = contract
  .flow("docs-example")
  .meta({ skip: "no live server" })
  .setup(async () => ({ x: 1 }));
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.equal(items[0].title, "⊘ skip: no live server");
  });

  it("ignores // @flow without a following export const", () => {
    const content = SDK_IMPORT + `
// @flow
// (no export here — malformed)
const ignored = 42;
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 0);
  });

  it("ignores // @flow when .flow(...) has no literal string id", () => {
    const content = SDK_IMPORT + `
const dynamicId = "computed";
// @flow
export const dynamic = contract.flow(dynamicId).setup(async () => ({}));
`;
    const items = computeContractLenses(content, FILE_PATH);
    assert.equal(items.length, 0);
  });

  it("emits contract AND flow lenses when a file declares both", () => {
    const content = SDK_IMPORT + `
const api = contract.http.with("demo", {});

// @contract
export const ping = api("ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "pong", expect: { status: 200 } } },
});

// @flow
export const smoke = contract
  .flow("ping-smoke")
  .step(ping.case("ok"));
`;
    const items = computeContractLenses(content, FILE_PATH);
    // Contract case "ok" + flow "ping-smoke" = 2 items.
    assert.equal(items.length, 2);
    const titles = items.map((i) => i.title).sort();
    assert.deepEqual(titles, ["▶ run ok", "▶ run ping-smoke"]);
  });
});

// ===========================================================================
// Bootstrap (attachment-model overlay) detector tests
// ===========================================================================

describe("computeContractLenses — *.bootstrap.ts overlay detection", () => {
  const BOOTSTRAP_PATH = "/tmp/proj/me.bootstrap.ts";

  it("resolves cross-file: lens args target the CONTRACT module, not the bootstrap module", () => {
    // Click-level smoke: the args produced here are exactly what flows into
    // `glubean.runContractCase` → `executeTest(filePath, [testId], ..., { exportName })`.
    // `filePath` MUST be the contract file (so the harness imports a module
    // that exports a real `Test`), and `exportName` MUST be the contract
    // export — the overlay export is a `BootstrapAttachment`, not runnable.
    // Overlay registration happens via §7.4 eager-load on the harness side
    // for ALL `*.bootstrap.ts` files, regardless of which file we pointed at.
    const bootstrapContent = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract.ts";

export const meAuthorizedOverlay = contract.bootstrap(
  getMe.case("authorized"),
  async (ctx) => ({ token: "tk" }),
);
`;
    const contractContent = `
import { contract } from "@glubean/sdk";
const api = contract.http.with("dummyjson", {});

// @contract
export const getMe = api("auth.me", {
  endpoint: "GET /auth/me",
  cases: { authorized: { description: "ok", expect: { status: 200 } } },
});
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "run");
    assert.equal(items[0].title, "▶ run auth.me.authorized");
    assert.deepEqual(items[0].args, {
      filePath: "/tmp/proj/me.contract.ts",
      testId: "auth.me.authorized",
      exportName: "getMe",
    });
  });

  it("resolves import path written WITHOUT .ts extension", () => {
    // `import { getMe } from "./me.contract"` — no extension.
    // Resolver must try common extensions in order.
    const bootstrapContent = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract";

export const meOverlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({ x: 1 }),
);
`;
    const contractContent = `
const api = contract.http.with("svc", {});
// @contract
export const getMe = api("svc.thing", {
  endpoint: "GET /x",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "▶ run svc.thing.ok");
  });

  it("emits multiple lenses when file has multiple bootstrap exports", () => {
    const bootstrapContent = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract.ts";

export const overlayA = contract.bootstrap(
  getMe.case("authorized"),
  async () => ({ token: "a" }),
);

export const overlayB = contract.bootstrap(
  getMe.case("requiresAttachment"),
  { params: undefined as any, run: async () => ({ token: "b" }) },
);
`;
    const contractContent = `
const api = contract.http.with("dummy", {});
// @contract
export const getMe = api("auth.me", {
  endpoint: "GET /auth/me",
  cases: {
    authorized: { description: "a", expect: { status: 200 } },
    requiresAttachment: { description: "b", expect: { status: 200 } },
  },
});
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 2);
    const titles = items.map((i) => i.title).sort();
    assert.deepEqual(titles, ["▶ run auth.me.authorized", "▶ run auth.me.requiresAttachment"]);
  });

  it("falls back to local lookup when contract is in the SAME file as the overlay", () => {
    // Inline overlay pattern: the `.contract.ts` file declares both the
    // contract AND its overlay. No import statement to scan.
    const content = `
import { contract } from "@glubean/sdk";
const api = contract.http.with("svc", {});

// @contract
export const getMe = api("svc.me", {
  endpoint: "GET /me",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});

export const meOverlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({ token: "tk" }),
);
`;
    // No readFile callback needed — local lookup path.
    const items = computeContractLenses(content, "/tmp/proj/me.contract.ts");
    // Both the contract case lens AND the bootstrap lens fire.
    assert.equal(items.length, 2);
    // Contract case lens (// @contract path) uses the case key for the title;
    // bootstrap lens uses the full `${contractId}.${case}` form. Distinct
    // titles let us tell them apart without depending on line numbers.
    const bootstrapItem = items.find((i) => i.title === "▶ run svc.me.ok");
    assert.ok(bootstrapItem, "bootstrap lens should be emitted from local lookup");
    assert.equal(bootstrapItem!.kind, "run");
    // Same-file overlay also targets the contract export (`getMe`), not the
    // overlay export (`meOverlay`). The harness needs a runnable `Test`.
    assert.deepEqual(bootstrapItem!.args, {
      filePath: "/tmp/proj/me.contract.ts",
      testId: "svc.me.ok",
      exportName: "getMe",
    });
  });

  it("emits disabled hint when the imported file is unreadable", () => {
    const bootstrapContent = `
import { getMe } from "./me.contract.ts";

export const overlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({}),
);
`;
    const readFile = () => undefined; // simulates missing file

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.match(items[0].title, /target file unreadable/);
  });

  it("emits disabled hint when the contract id is missing from the target file", () => {
    const bootstrapContent = `
import { getMe } from "./me.contract.ts";

export const overlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({}),
);
`;
    const contractContent = `
// File exists but doesn't declare \`getMe\` — maybe it was renamed.
export const somethingElse = api("foo", { cases: {} });
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.match(items[0].title, /target contract id not found/);
  });

  it("handles `as` import aliases", () => {
    const bootstrapContent = `
import { getMe as me } from "./me.contract.ts";

export const overlay = contract.bootstrap(
  me.case("ok"),
  async () => ({}),
);
`;
    const contractContent = `
// @contract
export const getMe = api("svc.me", {
  endpoint: "GET /me",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "▶ run svc.me.ok");
  });

  it("ignores files with no contract.bootstrap() exports", () => {
    const content = `
import { contract } from "@glubean/sdk";
// Just a regular contract file with no overlays.
const api = contract.http.with("svc", {});

// @contract
export const ping = api("svc.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const items = computeContractLenses(content, "/tmp/proj/ping.contract.ts");
    // Should produce ONLY the contract case lens (one), no bootstrap noise.
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "▶ run ok");
  });

  it("multi-line import block with multiple names", () => {
    const bootstrapContent = `
import {
  getMe,
  somethingElse,
} from "./me.contract.ts";

export const overlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({}),
);
`;
    const contractContent = `
// @contract
export const getMe = api("svc.me", {
  endpoint: "GET /me",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
    const readFile = (p: string) =>
      p === "/tmp/proj/me.contract.ts" ? contractContent : undefined;

    const items = computeContractLenses(bootstrapContent, BOOTSTRAP_PATH, readFile);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "▶ run svc.me.ok");
  });
});

// ===========================================================================
// Path / platform handling
// ===========================================================================
//
// VSCode `document.uri.fsPath` returns a platform-native path string —
// posix on macOS/Linux, win32 (backslash) on Windows. The cross-file
// overlay resolver must accept both. We simulate Windows by injecting
// `path.win32` as the optional 4th arg to `computeContractLenses` and
// using a `C:\…` style fsPath. (Without injection, the production code
// uses `node:path`, which is `path.posix` when this test runs on
// macOS/Linux — so we'd never exercise the Windows code path otherwise.)

describe("computeContractLenses — Windows fsPath compatibility", () => {
  it("resolves cross-file overlay imports under path.win32", () => {
    const bootstrapContent = `
import { contract } from "@glubean/sdk";
import { getMe } from "./me.contract.ts";

export const meAuthorizedOverlay = contract.bootstrap(
  getMe.case("authorized"),
  async () => ({ token: "tk" }),
);
`;
    const contractContent = `
// @contract
export const getMe = api("auth.me", {
  endpoint: "GET /auth/me",
  cases: { authorized: { description: "ok", expect: { status: 200 } } },
});
`;

    const winBootstrapPath = "C:\\proj\\me.bootstrap.ts";
    const winContractPath = "C:\\proj\\me.contract.ts";
    const readFile = (p: string) =>
      p === winContractPath ? contractContent : undefined;

    const items = computeContractLenses(
      bootstrapContent,
      winBootstrapPath,
      readFile,
      path.win32,
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "run", "Windows path should resolve, not fall to disabled hint");
    assert.equal(items[0].title, "▶ run auth.me.authorized");
    // The resolved target file path is the win32-joined absolute path.
    assert.equal(items[0].args?.filePath, winContractPath);
    assert.equal(items[0].args?.exportName, "getMe");
  });

  it("documents the bug: posix path resolution against a win32 fsPath fails", () => {
    // Regression guard for P2: the previous impl used `posix.dirname`
    // unconditionally, so on Windows fsPaths every cross-file overlay
    // produced an "unreadable" disabled hint. We assert the SHAPE of
    // the failure under path.posix — confirming that picking the wrong
    // path lib silently breaks resolution rather than throwing.
    const bootstrapContent = `
import { getMe } from "./me.contract.ts";

export const overlay = contract.bootstrap(
  getMe.case("ok"),
  async () => ({}),
);
`;
    const winBootstrapPath = "C:\\proj\\me.bootstrap.ts";
    const winContractPath = "C:\\proj\\me.contract.ts";
    const readFile = (p: string) =>
      p === winContractPath ? "// @contract\nexport const getMe = api(\"x.y\", { cases: { ok: {} } });\n" : undefined;

    const items = computeContractLenses(
      bootstrapContent,
      winBootstrapPath,
      readFile,
      path.posix, // wrong path lib on purpose
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "disabled");
    assert.match(items[0].title, /target file unreadable/);
  });
});

// ===========================================================================
// Provider registration patterns
// ===========================================================================

describe("CONTRACT_LENS_FILE_PATTERNS", () => {
  it("registers *.bootstrap.{ts,js,mjs} so VSCode invokes the provider on overlay files", () => {
    // Without these patterns in the DocumentSelector built in extension.ts,
    // `computeContractLenses` would still detect overlays in `*.bootstrap.ts`
    // files in tests, but VSCode would never call provideCodeLenses() on
    // them in the real editor — so users would see no overlay buttons.
    assert.ok(
      CONTRACT_LENS_FILE_PATTERNS.typescript.includes("**/*.bootstrap.ts"),
      "typescript selector must include **/*.bootstrap.ts",
    );
    assert.ok(
      CONTRACT_LENS_FILE_PATTERNS.javascript.includes("**/*.bootstrap.{js,mjs}"),
      "javascript selector must include **/*.bootstrap.{js,mjs}",
    );
  });

  it("keeps existing contract / flow patterns", () => {
    assert.ok(CONTRACT_LENS_FILE_PATTERNS.typescript.includes("**/*.contract.ts"));
    assert.ok(CONTRACT_LENS_FILE_PATTERNS.typescript.includes("**/*.flow.ts"));
    assert.ok(CONTRACT_LENS_FILE_PATTERNS.javascript.includes("**/*.contract.{js,mjs}"));
    assert.ok(CONTRACT_LENS_FILE_PATTERNS.javascript.includes("**/*.flow.{js,mjs}"));
  });
});
