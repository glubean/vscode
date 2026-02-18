# Glubean VS Code Extension — AI Agent Guidelines

This document provides instructions for AI agents (Cursor, Copilot, etc.) working on the Glubean VS Code extension.

## Codebase Context

This is a VS Code extension built with TypeScript and bundled with esbuild.

- **Runtime:** Node.js (VS Code extension host)
- **Bundler:** esbuild
- **Package Manager:** npm

## Git Workflow — Strict GitHub Flow

This repository follows **GitHub Flow**. No exceptions.

### Rules

1. **Never commit directly to `main`.** All changes — no matter how small — must go through a pull request.
2. **Create a feature branch** for every unit of work:
   - Branch from `main`
   - Use descriptive names: `feat/add-tree-view`, `fix/activation-error`, `docs/update-readme`
3. **Open a Pull Request** before merging. PRs must:
   - Have a clear title and description
   - Pass CI checks
   - Receive at least one approval (when reviewers are available)
4. **Merge via PR only.** Use squash-merge or merge commit per team preference — never push directly to `main`.
5. **Delete the branch** after merging.

### For AI Agents

- **Ask for explicit permission before every git operation.** This includes:
  - Creating a branch (`git checkout -b`)
  - Committing (`git commit`)
  - Pushing (`git push`)
  - Creating a PR (`gh pr create`)
- Never perform any of these operations silently or automatically. Always describe what you intend to do and wait for a clear "yes" or equivalent confirmation.
- **Never run `git push` to `main`** — push to the feature branch and open a PR.

## Version Alignment with OSS

This extension depends on packages published from the **glubean/glubean** (OSS) monorepo on JSR
(e.g., `@glubean/scanner`). Versions must stay aligned:

1. **Dependency versions in `package.json`** must match the latest published OSS version.
   - Example: if OSS is at `0.11.0`, then `"@glubean/scanner": "npm:@jsr/glubean__scanner@^0.11.0"`.
2. **When bumping OSS versions**, always update this repo's dependencies to match.
3. **Publishing workflow:**
   - Bump and publish all OSS packages first (`deno publish` in the OSS repo).
   - Then update `package.json` here, run `npm install`, and verify `npm run lint` + `npm run build`.
4. **New OSS packages** (e.g., `@glubean/auth`, `@glubean/graphql`) must be created on JSR before they can be published.

## Code Standards

- All code comments and documentation in English
- TypeScript strict mode
- Follow existing patterns in the codebase
