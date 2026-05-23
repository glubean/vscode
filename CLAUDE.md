# vscode — Glubean VSCode Extension

> **Workspace-level rules: see [`../internal/CLAUDE.md`](../internal/CLAUDE.md)** (read first if you haven't this session).

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

## Commit gate (default: converge)

Default — any commit, before "done":
1. Run the changed test files — paste real output, no summary
2. Run: `codex review --base <baseSha>`  (codex 5.5, --xhigh, no custom prompt)
3. P1+ findings fix-iterate to 0
4. Don't hand back with unresolved findings
5. RFR Round ≤ 3 — beyond that, owner decides "ship or abort"

Skip ONLY when owner explicitly says so (e.g. "just bump version", "only fix this typo"). Default is converge — never skip silently.
