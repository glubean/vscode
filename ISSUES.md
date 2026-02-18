# Known Issues

## Security

### 1. Remove `shell: true` from spawn calls

**Severity:** Medium

Three `spawn()` calls use `shell: true`, which means file paths with shell metacharacters could be interpreted unexpectedly.

- `extension.ts:37` — `cp.spawn(command, ["--version"], { shell: true })`
- `testController.ts:862` — `cp.spawn(glubeanPath, args, { shell: true })`
- `testController.ts:1359` — `cp.spawn(command, args, { shell: true })`

**Fix:** Use `shell: false` and ensure paths are properly resolved.

### 2. Replace `exec()` with `spawn` using argument arrays

**Severity:** Medium

`extension.ts:68-78` passes string commands to `cp.exec()`, which invokes a shell. This should use `cp.spawn()` with an argument array to avoid shell interpretation.

### 3. Add input validation for file paths and config values

**Severity:** Low

File paths, environment variables, and config strings are not validated before being passed to the CLI.

## Code Quality

### 4. Replace silent catch blocks in hover provider

**Severity:** Low

`hoverProvider.ts` has silent catch blocks in `parseEnvFile` and `resolveJsonImportKeys` that hide real errors. These should log to the output channel.

### 5. Improve `.env` file parsing

**Severity:** Low

Current parsing is simplistic — no handling for multiline values, escape sequences, or `export` prefix.

## Test Coverage

### 6. Add tests for untested modules

**Severity:** Low

The following have no test coverage:

- Debug handler (most complex, most error-prone)
- Hover provider (env file parsing, secret masking)
- CodeLens provider (JSON import resolution)
- Environment switcher
- Process cleanup (`killProcessGroup`)
- Port finding logic

## Documentation

### 7. Add troubleshooting section to README

**Severity:** Low

No guidance for common issues (PATH problems, Deno install failures, etc.).

### 8. Add SECURITY.md

**Severity:** Low

No documented process for reporting security vulnerabilities.

### 9. Recommend `.glubean/` in users' `.gitignore`

**Severity:** Low

Trace files in `.glubean/traces/` may contain full HTTP request/response bodies. Users should be advised to gitignore this directory.
