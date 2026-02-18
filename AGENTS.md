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

## Code Standards

- All code comments and documentation in English
- TypeScript strict mode
- Follow existing patterns in the codebase
