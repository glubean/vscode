# Releasing the VS Code Extension

This guide covers how to update, build, and release the Glubean VS Code
extension after OSS package changes.

## Prerequisites

The extension depends on packages from the OSS monorepo (`glubean/glubean`),
published to npm:

- `@glubean/runner` (test execution + bootstrap + env loader)
- `@glubean/scanner` (static + runtime contract extraction)
- `@glubean/sdk` (types; pulled transitively)

**Never update the extension until the OSS packages are published and
verified on npm.**

See [`../internal/10-architecture/publish-dependency-graph.md`](../../internal/10-architecture/publish-dependency-graph.md)
for the upstream release procedure.

## Release Workflow

### 1. Wait for OSS publication

After the monorepo release tag (e.g. `v0.2.6`) is pushed, CI runs the
"Publish to npm" workflow. Verify the versions landed:

```bash
npm view @glubean/runner version
npm view @glubean/scanner version
```

Do not proceed until the expected versions appear.

### 2. Update dependencies

Edit `package.json` to reference the new versions:

```json
"dependencies": {
  "@glubean/runner": "^0.2.4",
  "@glubean/scanner": "^0.2.2"
}
```

Regenerate both lockfiles — CI runs `pnpm install --frozen-lockfile`, but
`install:vscode` / `install:cursor` scripts use `npm install`, so both
`pnpm-lock.yaml` and `package-lock.json` must stay in sync:

```bash
pnpm install
npm install
```

### 3. Bump the extension version

**Every code change requires a version bump.** VS Code caches installed
extensions by version number — if the version stays the same, users will
silently get stale code even after reinstalling.

```json
"version": "0.17.38"
```

Guidelines:

- Dependency update or bug fix → bump **patch** (`0.17.37` → `0.17.38`)
- New feature or UI change → bump **minor** (`0.17.x` → `0.18.0`)

### 4. Install and verify

```bash
pnpm install        # or `npm install` — both lockfiles already updated
npm run lint        # tsc --noEmit + eslint
npm run build       # builds extension + webview bundles
```

### 5. Test locally

```bash
npm run install:vscode
```

Reopen VS Code (or reload the window) and verify the new behavior
end-to-end against a project that exercises the dependency changes
(e.g. a `.contract.ts` file using grpc/graphql plugins).

### 6. Commit + tag + push

```bash
git add -A
git commit -m "chore: bump vX.Y.Z, align @glubean/runner X.Y.Z + @glubean/scanner X.Y.Z"
git tag vX.Y.Z
git push && git push origin vX.Y.Z
```

CI publishes the new version to the VS Code Marketplace.

### 7. Cross-reference

Link the VSCode commit / tag back to the OSS monorepo release tag in the
commit message for traceability.

## Common Mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Update deps before npm publish completes | `npm install` pulls old package version | Wait and verify with `npm view` first |
| Change code without bumping `version` | Reinstall shows old behavior | Always bump `version` in `package.json` |
| Forget to regenerate both lockfiles | CI (pnpm) works but `install:vscode` (npm) uses stale versions, or vice versa | Always run both `pnpm install` and `npm install` after dep edits |
| Forget `npm install` after dep change | Build uses old cached dependency | Run `npm install` before `npm run build` |
