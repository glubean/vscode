# VSCode Extension Testing Strategy

## Principle

VSCode extension's responsibility ends at **constructing correct parameters for the runner**.
Runner correctness is tested in the runner package. Extension tests verify the chain:

```
Source code → Parser → CodeLens args → Command handler → ExecuteTestOptions → Runner CLI args
```

Each step is tested as input→output, no subprocess spawning needed.

## Test Layers

### 1. Parser (scanner)
- Input: TypeScript source text
- Output: test IDs, names, tags, pick names, export names
- Location: `src/testController/parser.test.ts`

### 2. CodeLens args
- Input: parsed test metadata
- Output: command args object `{ filePath, testId, exportName, pickKey }`
- Verify: correct shape for each test type (simple, each, pick)

### 3. Command handler → ExecuteTestOptions
- Input: CodeLens command args
- Output: `ExecuteTestOptions { pick, exportName, envFile }`
- Location: `src/testController/executor.test.ts`
- Verify: pick key and exportName are correctly threaded through

### 4. Executor env var management
- Input: `ExecuteTestOptions.pick`
- Output: `process.env.GLUBEAN_PICK` set/unset/restored
- Location: `src/testController/executor.test.ts`
- Verify: no env var leakage between runs

### 5. Generate Summary (runner integration)
- Input: timeline events array
- Output: `Summary { success, assertionTotal, httpErrorTotal, ... }`
- Location: `src/generate-summary.test.ts`
- Verify: correct success derivation, assertion/HTTP/step counting, edge cases

### 6. Environment Switcher
- Input: directory entries, env file names
- Output: filtered env file list, display names, parsed key-value pairs
- Location: `src/env-switcher.test.ts`
- Verify: .env.secrets/.env.local/.env.example exclusion, display name mapping

### 7. Result Viewer Logic
- Input: test objects with success flag and timeline events
- Output: derived success, filtered assertions, filtered traces
- Location: `src/result-viewer-logic.test.ts`
- Source: `src/webview/result-utils.ts` (extracted from ResultViewer.tsx)
- Verify: soft assertion failure overrides test.success, correct event filtering

### 8. Scratch Mode Detection
- Input: file paths, directory structure
- Output: test file detection, zero-project detection
- Location: `src/scratch-mode.test.ts`
- Verify: .test.{ts,js,mjs} matching, node_modules/@glubean/sdk existence check

## Constraints

`executor.ts` imports `vscode` which is unavailable in test. Tests replicate
the env var logic rather than importing directly. If executor logic changes,
update both the source and the test's replicated logic.

## Running Tests

```bash
npx tsx --test src/**/*.test.ts
```

Note: `parser.test.ts` requires `@glubean/scanner/static` — run `npm install` first.

## When to Add Tests

Any change to the **parameter construction chain** (parser → CodeLens → command → executor)
must have a corresponding test. If a user reports "clicking X does the wrong thing",
the fix must include a test that reproduces the wrong args and verifies the fix.
