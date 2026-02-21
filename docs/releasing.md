# Releasing the VS Code Extension

This guide covers how to update, build, and release the Glubean VS Code extension after OSS package changes.

## Prerequisites

The extension depends on packages from the OSS monorepo (`glubean/glubean`), published to JSR and consumed via npm
bridges (e.g., `npm:@jsr/glubean__scanner@^0.11.0`).

**Never update the extension until the OSS packages are published and verified on JSR.**

## Release Workflow

### 1. Wait for OSS publication

After an OSS PR merges to `main`, the `auto-patch` workflow publishes bumped packages to JSR. Verify:

```bash
curl -s https://jsr.io/@glubean/scanner/meta.json | jq .latest
```

Do not proceed until the expected version appears.

### 2. Update dependencies

Edit `package.json` to reference the new versions:

```json
"@glubean/scanner": "npm:@jsr/glubean__scanner@^0.11.1"
```

### 3. Bump the extension version

**Every code change requires a version bump.** VS Code caches installed extensions by version number — if the version
stays the same, users will silently get stale code even after reinstalling.

```json
"version": "0.2.2"
```

Guidelines:

- Dependency update or bug fix → bump **patch** (`0.2.1` → `0.2.2`)
- New feature or UI change → bump **minor** (`0.2.x` → `0.3.0`)

### 4. Install and verify

```bash
npm install
npm run lint
npm run build
```

### 5. Test locally

```bash
npm run install:vscode
```

Reopen VS Code (or reload the window) and verify the new behavior end-to-end.

### 6. Cross-reference

Link the VSCode PR back to the OSS PR (and vice versa) in PR descriptions for traceability.

## Common Mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Update deps before JSR publish completes | `npm install` pulls old package version | Wait and verify with `curl` first |
| Change code without bumping `version` | Reinstall shows old behavior | Always bump `version` in `package.json` |
| Forget `npm install` after dep change | Build uses old cached dependency | Run `npm install` before `npm run build` |
