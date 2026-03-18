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
