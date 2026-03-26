/**
 * AI Refactor — pure functions for scenario detection and prompt building.
 *
 * No vscode dependency — safe to import from tests.
 */

import type { TestMeta } from "./parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Scenario {
  type: "copy-context" | "extract-data" | "promote-explore" | "extract-config" | "convert-to-pick" | "promote-to-metadata";
  label: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Scenario detection
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count inline data cases in test.each() or test.pick() calls.
 *
 * Supports both object literals (`{ key1: ..., key2: ... }`) and
 * array literals (`[ { ... }, { ... } ]`).
 */
export function countInlineCases(content: string, exportName: string): number {
  const exportPattern = new RegExp(
    `export\\s+const\\s+${escapeRegex(exportName)}\\s*=\\s*test\\s*\\.\\s*(?:each|pick)\\s*\\(`,
  );
  const match = exportPattern.exec(content);
  if (!match) return 0;

  const startIdx = match.index + match[0].length;
  const rest = content.slice(startIdx).trimStart();

  if (rest.startsWith("{")) {
    // Object literal: count top-level keys
    return countObjectKeys(content, startIdx + (content.slice(startIdx).length - rest.length));
  }

  if (rest.startsWith("[")) {
    // Array literal: count top-level elements (objects or primitives)
    return countArrayElements(content, startIdx + (content.slice(startIdx).length - rest.length));
  }

  return 0;
}

function countObjectKeys(content: string, braceStart: number): number {
  let depth = 0;
  let keyCount = 0;
  let i = braceStart;

  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && (ch === '"' || ch === "'")) {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      keyCount++;
    } else if (depth === 1 && /[a-zA-Z_$]/.test(ch)) {
      keyCount++;
      while (i < content.length && content[i] !== ":" && content[i] !== "," && content[i] !== "}") {
        i++;
      }
      continue;
    }
    i++;
  }
  return keyCount;
}

function countArrayElements(content: string, bracketStart: number): number {
  let depth = 0;
  let count = 0;
  let hasContent = false;
  let i = bracketStart;

  while (i < content.length) {
    const ch = content[i];
    if (ch === "[" || ch === "{" || ch === "(") {
      if (depth === 1 && !hasContent) { count++; hasContent = true; }
      depth++;
    } else if (ch === "]" || ch === "}" || ch === ")") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && ch === ",") {
      hasContent = false;
    } else if (depth === 1 && !/\s/.test(ch)) {
      if (!hasContent) { count++; hasContent = true; }
    }
    i++;
  }
  return count;
}

/**
 * Extract the source block for a given export name.
 */
export function extractExportBlock(content: string, exportName: string): string {
  const pattern = new RegExp(
    `^export\\s+const\\s+${escapeRegex(exportName)}\\b`,
    "m",
  );
  const match = pattern.exec(content);
  if (!match) return "";

  const startIdx = match.index;
  let depth = 0;
  let started = false;
  let i = startIdx + match[0].length;

  while (i < content.length) {
    const ch = content[i];
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      started = true;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
    } else if (ch === "`" || ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
    } else if (started && depth === 0 && ch === ";") {
      return content.slice(startIdx, i + 1).trim();
    }
    i++;
  }
  return content.slice(startIdx).trim();
}

/**
 * Returns true if any URL string appears 2+ times within the given text.
 */
export function hasRepeatedUrls(text: string): boolean {
  const urlMatches = text.match(/https?:\/\/[^\s"'`)+\]}>]+/g);
  if (!urlMatches || urlMatches.length < 2) return false;

  const counts = new Map<string, number>();
  for (const url of urlMatches) {
    const count = (counts.get(url) ?? 0) + 1;
    counts.set(url, count);
    if (count >= 2) return true;
  }
  return false;
}

/**
 * Return all refactor scenarios for a test.
 *
 * Every test gets every option — the user picks what's relevant.
 * Labels must be self-explanatory since there's no smart filtering.
 */
export function detectRefactorScenarios(
  _content: string,
  _filePath: string,
  _meta: TestMeta,
): Scenario[] {
  return [
    {
      type: "copy-context",
      label: "Copy context",
      detail: "Copy test context to clipboard — paste into your AI agent",
    },
    {
      type: "extract-data",
      label: "Extract inline data to file",
      detail: "Move inline test data into a YAML/JSON data file",
    },
    {
      type: "convert-to-pick",
      label: "Convert to data-driven test",
      detail: "Parametrize hardcoded values with test.pick() + data file",
    },
    {
      type: "promote-to-metadata",
      label: "Convert ID to metadata object",
      detail: "Change string ID to { id, ... } for adding config options",
    },
    {
      type: "extract-config",
      label: "Extract request setup to config",
      detail: "Move repeated URL/headers into configure()",
    },
    {
      type: "promote-explore",
      label: "Promote to tests/",
      detail: "Move this explore flow into committed verification",
    },
  ];
}

// ---------------------------------------------------------------------------
// Prompt building — lightweight "teaching affordance" style
// ---------------------------------------------------------------------------

/**
 * Build a prompt for a given scenario.
 *
 * Prompts are intentionally slim: file path, test id, intent, guardrails.
 * The AI tool already has access to the workspace — it can read the file itself.
 */
export function buildPrompt(
  scenario: Scenario,
  filePath: string,
  meta: TestMeta,
): string {
  const testId = meta.id.replace(/^(each|pick):/, "");
  const body = buildPromptBody(scenario, filePath, meta, testId);
  return `/glubean\n${body}`;
}

function buildPromptBody(
  scenario: Scenario,
  filePath: string,
  meta: TestMeta,
  testId: string,
): string {
  switch (scenario.type) {
    case "copy-context":
      return [
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
      ].join("\n");

    case "extract-data":
      return [
        "## Task",
        "Extract the inline test data into a YAML file.",
        "",
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
        "",
        "## Instructions",
        "1. Read the file above and find the inline data in the test.each/test.pick call",
        "2. Create a single YAML data file under `data/` using the test ID as the filename",
        "3. Rewrite the test to load it with `fromYaml`",
        "4. Preserve all test IDs and assertions",
        "5. If a folder-based structure is clearly better, ask whether the user prefers file or folder before splitting",
      ].join("\n");

    case "promote-explore":
      return [
        "## Task",
        "Promote this `explore/` test into committed verification under `tests/`.",
        "",
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
        "",
        "## Instructions",
        "1. Read the file above",
        "2. Move or copy the test to the corresponding path under `tests/`",
        "3. Preserve behavior and existing assertions",
        "4. Add stronger assertions if obviously needed (status codes, response shape)",
        "5. Keep test IDs stable",
      ].join("\n");

    case "extract-config":
      return [
        "## Task",
        "Extract repeated request setup (base URL, headers, auth) into a `configure()` block.",
        "",
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
        "",
        "## Instructions",
        "1. Read the file above and identify repeated URL/header/auth patterns",
        "2. Create or update a shared config file in `config/`",
        "3. Use `configure()` with `{{KEY}}` template syntax for env references",
        "4. Rewrite the test to use the shared HTTP client",
        "5. Preserve behavior while reducing duplicated setup",
      ].join("\n");

    case "convert-to-pick":
      return [
        "## Task",
        "Convert this test to a data-driven `test.pick()` test.",
        "",
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
        "",
        "## Instructions",
        "1. Read the file above and identify hardcoded request parameters (URLs, body, headers)",
        "2. Extract the parameters into a YAML data file under `data/` using the test ID as the filename",
        "3. Rewrite the test to use `test.pick(await fromYaml.map(...))(\"${testId}-$_pick\", callback)`",
        "4. Each key in the data file should be a meaningful scenario name",
        "5. Preserve all existing assertions and behavior",
      ].join("\n");

    case "promote-to-metadata":
      return [
        "## Task",
        "Convert the string ID to a metadata object.",
        "",
        `**File:** ${filePath}`,
        `**Export:** ${meta.exportName}`,
        `**Test ID:** ${testId}`,
        "",
        "## Instructions",
        "1. Read the file above and find the test definition",
        "2. Change `test(\"${testId}\", ...)` to `test({ id: \"${testId}\" }, ...)`",
        "3. Do not add any extra configuration fields — the user will add them as needed",
        "4. If this is a chained call like `test.each(...)( \"${testId}\", ...)`, apply the same change to the ID argument",
      ].join("\n");
  }
}
