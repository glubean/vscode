# Known Issues

## Code Quality

### 1. Silent catch blocks in hover provider

**Severity:** Low

`hoverProvider.ts` has silent catch blocks in `parseEnvFile` and `resolveJsonImportKeys` that hide real errors. Should log to the output channel.

### 2. Simplistic `.env` file parsing

**Severity:** Low

No handling for multiline values, escape sequences, or `export` prefix.

## Documentation

### 3. Add SECURITY.md

**Severity:** Low

No documented process for reporting security vulnerabilities.

### 4. Recommend `.glubean/` in users' `.gitignore`

**Severity:** Low

Result files in `.glubean/results/` may contain full HTTP request/response bodies.
