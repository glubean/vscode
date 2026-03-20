/**
 * P2 regression tests for snippet JSON validation.
 *
 * Validates that all snippets have required fields, no duplicate prefixes,
 * and that snippet bodies produce parseable TypeScript/JavaScript.
 *
 * Run with: npx tsx --test src/snippets.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Load snippet files
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNIPPETS_DIR = path.resolve(__dirname, "../snippets");

interface Snippet {
  prefix: string | string[];
  body: string[];
  description: string;
}

function loadSnippets(): Record<string, Snippet> {
  const files = fs
    .readdirSync(SNIPPETS_DIR)
    .filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "Expected at least one snippet JSON file");

  let all: Record<string, Snippet> = {};
  for (const file of files) {
    const content = fs.readFileSync(path.join(SNIPPETS_DIR, file), "utf-8");
    const parsed = JSON.parse(content) as Record<string, Snippet>;
    all = { ...all, ...parsed };
  }
  return all;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("snippets validation", () => {
  const snippets = loadSnippets();
  const names = Object.keys(snippets);

  it("has at least one snippet", () => {
    assert.ok(names.length > 0);
  });

  it("every snippet has prefix and description", () => {
    for (const name of names) {
      const snippet = snippets[name];
      assert.ok(
        snippet.prefix !== undefined && snippet.prefix !== null,
        `Snippet "${name}" is missing prefix`,
      );
      assert.ok(
        snippet.description && snippet.description.length > 0,
        `Snippet "${name}" is missing description`,
      );
    }
  });

  it("every snippet has a non-empty body", () => {
    for (const name of names) {
      const snippet = snippets[name];
      assert.ok(
        Array.isArray(snippet.body) && snippet.body.length > 0,
        `Snippet "${name}" has empty or missing body`,
      );
    }
  });

  it("no duplicate prefixes across all snippets", () => {
    const seen = new Map<string, string>();
    for (const name of names) {
      const prefixes = Array.isArray(snippets[name].prefix)
        ? snippets[name].prefix
        : [snippets[name].prefix];
      for (const p of prefixes) {
        assert.ok(
          !seen.has(p),
          `Duplicate prefix "${p}" in "${name}" (already used by "${seen.get(p)}")`,
        );
        seen.set(p, name);
      }
    }
  });

  it("snippet body concatenates to parseable code (no syntax errors)", () => {
    for (const name of names) {
      const snippet = snippets[name];
      // Strip VS Code tab-stop placeholders: ${1:foo} -> foo, $1 -> ""
      const raw = snippet.body.join("\n");
      const cleaned = raw
        .replace(/\$\{(\d+):([^}]*)}/g, "$2")
        .replace(/\$\d+/g, "placeholder");

      // Use Function constructor as a lightweight syntax check. We wrap
      // in an async function to allow top-level await keywords.
      // Transformations to make TS snippets parse as JS:
      // 1. Strip import lines
      // 2. Replace `export const` with `const`
      // 3. Strip TypeScript generics (e.g. .json<Type>() -> .json())
      // 4. Strip type annotations in destructuring
      const asJs = cleaned
        .split("\n")
        .filter((l) => !l.trim().startsWith("import "))
        .map((l) => l.replace(/^\s*export\s+const\s+/, "const "))
        .join("\n")
        // Strip simple generics like <Type>, <{ ... }>
        .replace(/<(?:[^<>]|<[^<>]*>)*>/g, "")
        // Strip template literal escapes that VS Code handles (\${...} -> ${...})
        .replace(/\\(\$\{)/g, "$1");

      try {
        // eslint-disable-next-line no-new-func
        new Function(`"use strict"; return (async () => { ${asJs} })();`);
      } catch (err) {
        assert.fail(
          `Snippet "${name}" body is not parseable:\n${(err as Error).message}\n---\n${asJs}`,
        );
      }
    }
  });

  it("contains core snippets: gb-scratch, gb-t, gb-each, gb-pick, gb-config", () => {
    const allPrefixes = new Set<string>();
    for (const name of names) {
      const prefixes = Array.isArray(snippets[name].prefix)
        ? snippets[name].prefix
        : [snippets[name].prefix];
      for (const p of prefixes) {
        allPrefixes.add(p);
      }
    }

    const required = ["gb-scratch", "gb-t", "gb-each", "gb-pick", "gb-config"];
    for (const prefix of required) {
      assert.ok(
        allPrefixes.has(prefix),
        `Missing core snippet with prefix "${prefix}"`,
      );
    }
  });
});
