/**
 * Unit tests for the cwd-aware runner resolution.
 *
 * The pure `resolveRunnerSource(cwd, fsApi)` is the testable surface;
 * the dynamic-import wrapper `loadRunnerForCwd` is glue that we don't
 * exercise here (it would require a real on-disk runner). The pure
 * function captures the entire resolution decision tree.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import {
  resolveRunnerSource,
  type RunnerFsApi,
} from "./loadRunner";

/** Build a stub `fs` for tests, keyed by absolute path. */
function stubFs(files: Record<string, string>): RunnerFsApi {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p, _encoding) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p];
    },
  };
}

const cwd = "/Users/u/proj";
const runnerDir = path.join(cwd, "node_modules", "@glubean", "runner");
const pkgPath = path.join(runnerDir, "package.json");

const sdkPkgPath = path.join(cwd, "node_modules", "@glubean", "sdk", "package.json");

describe("resolveRunnerSource", () => {
  it("returns vendored with `no-sdk-no-runner` when neither sdk nor runner is installed (true scratch shape)", () => {
    const res = resolveRunnerSource(cwd, stubFs({}));
    assert.equal(res.source, "vendored");
    assert.equal(res.vendoredReason, "no-sdk-no-runner");
    assert.equal(res.entryPath, undefined);
  });

  it("returns vendored with `sdk-without-runner` when sdk is installed but runner is missing (DUAL-INSTANCE HAZARD)", () => {
    // The bug shape: user has @glubean/sdk in their project but not
    // @glubean/runner. Loading vendored runner WOULD work for tests that
    // never touch configure() lazy values, but configure()/vars/secrets
    // access throws because vendored harness sets runtime on the vendored
    // sdk while user code reads from the project sdk. This branch surfaces
    // the misconfiguration so the loader can emit a strong warning before
    // the runtime error occurs.
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [sdkPkgPath]: JSON.stringify({ name: "@glubean/sdk", version: "0.2.3" }),
      }),
    );
    assert.equal(res.source, "vendored");
    assert.equal(res.vendoredReason, "sdk-without-runner");
  });

  it("returns project when package.json + entry exist (exports['.'].import)", () => {
    const entryAbs = path.join(runnerDir, "dist", "index.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.2.5",
          exports: { ".": { import: "./dist/index.js", default: "./dist/index.js" } },
        }),
        [entryAbs]: "// entry stub\n",
      }),
    );
    assert.equal(res.source, "project");
    assert.equal(res.entryPath, entryAbs);
    assert.equal(res.version, "0.2.5");
  });

  it("falls back to vendored when entry file is missing despite package.json", () => {
    // package.json present, but the entry it points at doesn't exist on disk.
    // This is the "broken install" path — pnpm hoisted a stale package.json
    // without the dist/, or someone deleted dist/ between build and run.
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.2.5",
          exports: { ".": { import: "./dist/index.js" } },
        }),
        // entry file intentionally not registered
      }),
    );
    assert.equal(res.source, "vendored");
    assert.equal(res.vendoredReason, "entry-missing");
  });

  it("falls back to vendored when package.json is malformed", () => {
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: "{ this is not json",
      }),
    );
    assert.equal(res.source, "vendored");
    assert.equal(res.vendoredReason, "malformed-package-json");
  });

  it("supports `exports['.']` as a bare string", () => {
    // Older / minimal package.json shape.
    const entryAbs = path.join(runnerDir, "dist", "index.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.1.40",
          exports: { ".": "./dist/index.js" },
        }),
        [entryAbs]: "",
      }),
    );
    assert.equal(res.source, "project");
    assert.equal(res.entryPath, entryAbs);
    assert.equal(res.version, "0.1.40");
  });

  it("supports `exports['.'].import` as a conditional object with default", () => {
    const entryAbs = path.join(runnerDir, "dist", "index.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.3.0",
          exports: {
            ".": {
              import: { default: "./dist/index.js", types: "./dist/index.d.ts" },
            },
          },
        }),
        [entryAbs]: "",
      }),
    );
    assert.equal(res.source, "project");
    assert.equal(res.entryPath, entryAbs);
  });

  it("falls back to top-level `module` when no exports field", () => {
    const entryAbs = path.join(runnerDir, "lib", "esm.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.0.1",
          module: "lib/esm.js",
          main: "lib/cjs.js",
        }),
        [entryAbs]: "",
      }),
    );
    assert.equal(res.source, "project");
    assert.equal(res.entryPath, entryAbs);
  });

  it("falls back to `main` when neither exports nor module is present", () => {
    const entryAbs = path.join(runnerDir, "index.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.0.1",
          main: "index.js",
        }),
        [entryAbs]: "",
      }),
    );
    assert.equal(res.source, "project");
    assert.equal(res.entryPath, entryAbs);
  });

  it("returns absolute entryPath even when package.json lists relative entry", () => {
    // Entries in package.json are always relative; loader must resolve to
    // absolute for `pathToFileURL()` to produce a working `import()` URL.
    const entryAbs = path.join(runnerDir, "dist", "index.js");
    const res = resolveRunnerSource(
      cwd,
      stubFs({
        [pkgPath]: JSON.stringify({
          name: "@glubean/runner",
          version: "0.2.5",
          exports: { ".": { import: "./dist/index.js" } },
        }),
        [entryAbs]: "",
      }),
    );
    assert.ok(path.isAbsolute(res.entryPath!), "entryPath must be absolute");
    assert.equal(res.entryPath, entryAbs);
  });
});

// ---------------------------------------------------------------------------
// T4 — dual-SDK-instance regression (hermetic)
// ---------------------------------------------------------------------------
//
// History: pre-loadRunnerForCwd, VSCode imported `@glubean/runner` from
// its vendored copy at `dist/node_modules/@glubean/runner`. The vendored
// runner bundled its own `@glubean/sdk`. When the harness subprocess
// (path resolved relative to harness.js) imported `@glubean/sdk`, Node
// resolution found the vendored copy. But the user's test code imported
// `@glubean/sdk` from the project's own node_modules — a DIFFERENT
// module instance. After SDK 0.2.1's removal of the
// `globalThis.__glubeanRuntime` shim, those two SDK instances stopped
// sharing state through the implicit global bridge: harness `setRuntime`
// wrote to vendored sdk's closure-scoped slot; user code read from
// project sdk's empty slot; `configure()` lazy access threw.
//
// `loadRunnerForCwd` was the architectural fix: VSCode resolves runner
// from the user's project node_modules first, so harness + user test
// code both resolve to the SAME `@glubean/sdk` instance.
//
// This test pins the contract empirically WITHOUT machine-local paths:
//   - dual-instance proof: load `vscode/node_modules/@glubean/sdk` (the
//     transitive dep hoisted by pnpm) AND `vscode/dist/node_modules/
//     @glubean/sdk` (the vendored copy after `npm run build:vendor`).
//     Both paths exist within the vscode repo itself; CI has both.
//   - resolver proof: build a minimal fixture project at runtime
//     (tmp dir with a stub node_modules/@glubean/runner/package.json +
//     entry) and assert `resolveRunnerSource` picks `"project"`.
//
// If preconditions fail (e.g. fresh checkout without build:vendor or
// pnpm install), the dual-instance test hard-fails with a clear message
// rather than skipping silently — silent skip was how the dual-instance
// bug shipped in the first place.

import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("dual-SDK-instance hazard (T4 — load-bearing assumption check)", () => {
  // Both paths live inside this very repo — no cookbook dep, no
  // machine-local hardcoding. CI must have run `pnpm install` (for the
  // hoisted SDK) AND `npm run build:vendor` (for the vendored SDK)
  // before this test, which are already standard CI steps.
  const vendoredSdkInternal = path.resolve(
    __dirname,
    "../../dist/node_modules/@glubean/sdk/dist/internal.js",
  );
  const hoistedSdkInternal = path.resolve(
    __dirname,
    "../../node_modules/@glubean/sdk/dist/internal.js",
  );

  it("two SDK module loads from different paths produce isolated state", async () => {
    if (!existsSync(vendoredSdkInternal)) {
      throw new Error(
        `T4 precondition: vendored SDK missing at ${vendoredSdkInternal}. ` +
          `Run \`npm run build:vendor\` before tests. (Hard-failing instead ` +
          `of skipping — silent skip is how the dual-instance bug shipped.)`,
      );
    }
    if (!existsSync(hoistedSdkInternal)) {
      throw new Error(
        `T4 precondition: hoisted SDK missing at ${hoistedSdkInternal}. ` +
          `Run \`pnpm install\` before tests.`,
      );
    }

    type SdkInternal = {
      setRuntime: (rt: unknown) => void;
      getRuntime: () => unknown;
    };
    const vendored = (await import(pathToFileURL(vendoredSdkInternal).href)) as SdkInternal;
    const hoisted = (await import(pathToFileURL(hoistedSdkInternal).href)) as SdkInternal;

    // Two different module instances even at the same SDK version — Node
    // ESM import key includes the file URL, and these are distinct files.
    assert.notStrictEqual(
      vendored,
      hoisted,
      "vendored and hoisted SDK should be different module instances (proves the dual-load is real)",
    );

    // setRuntime on vendored does NOT propagate to hoisted.
    vendored.setRuntime({
      vars: { CHECK: "from-vendored" },
      secrets: {},
      session: {},
      http: () => undefined,
    } as unknown);

    const seenFromVendored = vendored.getRuntime();
    const seenFromHoisted = hoisted.getRuntime();

    assert.ok(
      seenFromVendored !== undefined,
      "vendored.getRuntime() should see what vendored.setRuntime set",
    );
    assert.equal(
      seenFromHoisted,
      undefined,
      "hoisted.getRuntime() must NOT see vendored.setRuntime — confirms the dual-instance hazard exists",
    );
  });

  it("loadRunnerForCwd resolution prefers project-local when fixture exists (no machine-local paths)", () => {
    // Build a minimal fixture project at runtime. No cookbook dep, no
    // machine-local path. The fixture only needs a `node_modules/@glubean/
    // runner/package.json` + a stub entry — the resolver doesn't actually
    // import the entry, just verifies it exists.
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "glubean-loadRunner-fixture-"));
    try {
      const runnerDir = path.join(fixtureRoot, "node_modules", "@glubean", "runner");
      mkdirSync(path.join(runnerDir, "dist"), { recursive: true });
      writeFileSync(
        path.join(runnerDir, "package.json"),
        JSON.stringify({
          name: "@glubean/runner",
          version: "0.2.6",
          exports: { ".": { import: "./dist/index.js" } },
        }),
      );
      writeFileSync(
        path.join(runnerDir, "dist", "index.js"),
        "// fixture stub\nexport default {};\n",
      );

      const res = resolveRunnerSource(fixtureRoot);
      assert.equal(
        res.source,
        "project",
        "loadRunnerForCwd MUST prefer project-local runner when present — that's the architectural fix for the dual-instance hazard",
      );
      assert.ok(
        res.entryPath?.startsWith(fixtureRoot),
        `entryPath should be inside the fixture (got: ${res.entryPath})`,
      );
      assert.equal(res.version, "0.2.6");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
