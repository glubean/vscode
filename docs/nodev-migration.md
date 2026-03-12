# VSCode Extension: Deno → Node Migration

## Summary

Migrated the VSCode extension from CLI subprocess dependency (`deno run jsr:@glubean/cli`) to direct `@glubean/runner` library import. Users only need Node.js (bundled with VS Code) — zero external dependencies.

**Architecture change:**
```
Before: VSCode → spawn CLI binary → CLI loads runner → tsx harness
After:  VSCode → import @glubean/runner → TestExecutor → tsx harness
```

## Key Decisions

### 1. Runner as External (not bundled by esbuild)

Runner is marked `--external:@glubean/runner` in esbuild because:
- Runner spawns `harness.js` as a **separate subprocess** via tsx
- `harness.js` must exist as a real file on disk — can't be inlined into extension.js
- Runner uses `import.meta.url` + `__dirname` to locate `harness.js`

### 2. Vendoring Strategy (for vsix packaging)

Runner and all transitive deps are vendored into `dist/node_modules/` via `scripts/vendor-runner.mjs`:

```
dist/
  extension.js            ← esbuild bundle (CJS), runner external
  node_modules/
    @glubean/runner/      ← from npm
    @glubean/sdk/
    tsx/                  ← TypeScript execution for user test files
    esbuild/              ← tsx dependency (~10MB native binary)
    @esbuild/darwin-arm64/
    ky/
    yaml/
    get-tsconfig/
    resolve-pkg-maps/
```

**Why npm install in temp dir:** pnpm monorepo hoists transitive deps (esbuild, get-tsconfig, resolve-pkg-maps) to the root. Manually copying packages one by one was a "whack-a-mole" approach. Instead, `npm install @glubean/runner` in a temp dir resolves the complete dependency tree correctly.

### 3. Published Packages

Published to npm (required for vendor script):
- `@glubean/sdk@0.1.0`
- `@glubean/runner@0.1.1`

Runner depends on sdk via `^0.1.0` (changed from `workspace:*` for publishing).

### 4. harness.ts → harness.js

Runner's executor referenced `harness.ts` (TypeScript source), but npm-published package only contains `dist/` (compiled JS). Fixed to `harness.js`. tsx can execute `.js` files fine — it's still needed to compile user's `.ts` test files.

## Development Workflow

### F5 (Extension Development Host) — daily development

No vendoring needed. Runner resolves via `file:` link in package.json:

```json
"@glubean/runner": "file:../nodev/packages/runner"
```

Changes to runner code → `npm run build` in nodev → Cmd+R in Extension Host.

**Important:** Must disable/uninstall the marketplace version of Glubean extension, otherwise it takes priority over the dev version.

### Packaging vsix — for release

```bash
npm run package  # runs: build:extension + build:webview + build:vendor → vsce package
```

`build:vendor` runs `vendor-runner.mjs` which:
1. Creates temp dir with `npm install @glubean/runner`
2. Copies resolved `node_modules/` to `dist/node_modules/`
3. Cleans `.bin/` and `.package-lock.json`

`vsce package --no-dependencies` skips npm's dependency validation (which fails on `file:` links).

### launch.json

```json
{
  "name": "Run Extension",
  "type": "extensionHost",
  "request": "launch",
  "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
  "outFiles": ["${workspaceFolder}/dist/**/*.js"],
  "preLaunchTask": "watch"
}
```

Can add a project path to `args` to auto-open it in the Extension Host window.

## Files Changed (from Deno era)

### Removed (~1900 lines)
- All Deno/CLI dependency management from `extension.ts` (~900 lines): version checks, PATH augmentation, `~/.deno/bin`, periodic dep recheck timer, setup status bar, install prompts
- `testController/exec.ts` + `exec.test.ts` (CLI subprocess spawner)
- `testController.utils.ts`: `buildArgs()` function (CLI arg builder)
- `preRunCheck` / `setPreRunCheck` pattern
- `glubean.initProject` command (depended on CLI binary)
- `glubean.glubeanPath` config setting
- deno.json/deno.jsonc activation events

### Added (~700 lines)
- `executor.ts`: wraps `@glubean/runner` TestExecutor with VSCode integration (AbortSignal, progress, trace handling)
- `envLoader.ts`: loads `.env` files for test execution
- `scripts/vendor-runner.mjs`: vendoring script for vsix packaging

### Modified
- `testController.ts`: uses executor.ts instead of exec.ts
- `taskPanel/parser.ts`: reads `package.json` scripts instead of `deno.json` tasks
- `taskPanel/runner.ts`: `npm run` instead of `deno task`
- `package.json`: `file:` dep on runner, build:vendor script, `--no-dependencies` flag
- `.vscodeignore`: removed `node_modules/@glubean/runner` exception, added `scripts/`, `.VSCodeCounter/`
- Config watcher: `**/package.json` instead of `**/{deno.json,deno.jsonc}`

## Known Issues / Future Work

1. **vsix size (~10MB):** esbuild native binary is the bulk. Future option: install deps into `globalStorageUri` on first activation instead of vendoring.
2. **Platform-specific:** Current vendor only includes the build machine's esbuild binary (e.g., darwin-arm64). Cross-platform packaging would need platform-specific vsix builds or runtime install.
3. **Task panel:** Still reads `package.json` scripts with `gb run` commands. Works when Node CLI (`npx gb`) is published. No immediate action needed.
4. **test.pick() codelens:** "Test not found" error when clicking individual pick items — needs investigation (may be pre-existing).

## Cross-Repo Dependencies

```
nodev/packages/sdk  →  npm @glubean/sdk
nodev/packages/runner  →  npm @glubean/runner  →  depends on @glubean/sdk
vscode  →  file:../nodev/packages/runner (dev)  /  npm @glubean/runner (vsix)
```

When changing runner: change in nodev → build → F5 test in vscode. Only publish to npm when ready to package vsix for users.
