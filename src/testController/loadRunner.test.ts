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

describe("resolveRunnerSource", () => {
  it("returns vendored when no project-local @glubean/runner package.json exists", () => {
    const res = resolveRunnerSource(cwd, stubFs({}));
    assert.equal(res.source, "vendored");
    assert.equal(res.vendoredReason, "no-local-package");
    assert.equal(res.entryPath, undefined);
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
