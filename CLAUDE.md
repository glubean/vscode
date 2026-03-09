# vscode — Glubean VSCode Extension

## What This Repo Is
VSCode extension for Glubean. Provides test discovery, CodeLens, run/debug, trace viewer.

**Feature Map:** Before modifying, check `internal/00-overview/feature-map/vscode.md` for existing capabilities.

## Current Focus (updated 2026-03-03)
1. **URGENT: Currently on `fix/vscode-hardening` branch with 3 unmerged commits.** Finish and merge this first.
2. N2: Fix parse race (debounce + mutex) — this is a Now item
3. N3: Fix debug poll/process cleanup leaks

## Version Policy (Pre-Launch)
- ALL version bumps are PATCH only (0.x.Y) until public launch.
- Current version: 0.12.4 (in package.json on fix/vscode-hardening branch).
- Every merge to main MUST be followed by version bump + publish to VS Code Marketplace.
- Workflow: branch → PR → squash-merge → bump version → publish → delete branch.

## Branch Discipline
- **One active branch at a time.**
- Current active: `fix/vscode-hardening` — MUST be resolved before starting new work.
- `chore/bump-min-cli` — check if still relevant, delete or merge.
- 2 stashes exist (`feat/viewer-redesign`, `feat/telemetry`) — review and decide: apply or drop.
- If the user tries to create a new branch while one is active, ask: "当前 branch 还没处理完，要先 merge 还是 stash？"

## Tech Notes
- TypeScript + esbuild bundling
- Publishes to VS Code Marketplace via vsce
