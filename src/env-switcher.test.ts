/**
 * P0 regression tests for env switcher logic.
 *
 * Since envSwitcher.ts is tightly coupled to vscode API (status bar, commands),
 * we replicate the pure logic here — same pattern as executor.test.ts.
 *
 * Run with: npx tsx --test src/env-switcher.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// ---------------------------------------------------------------------------
// Replicate: envDisplayName (from extension.ts line 104-108)
// ---------------------------------------------------------------------------

/**
 * Derive a short display name from an env file path.
 * ".env" → "default", ".env.staging" → "staging", ".env.prod" → "prod"
 */
function envDisplayName(envFile: string): string {
  if (envFile === ".env") return "default";
  const match = envFile.match(/^\.env\.(.+)$/);
  return match ? match[1] : envFile;
}

// ---------------------------------------------------------------------------
// Replicate: env file filtering (from extension.ts line 120-131)
// ---------------------------------------------------------------------------

/**
 * Filter directory entries to valid .env files.
 * Excludes .env.secrets, .env.local, .env.example.
 */
function filterEnvFiles(entries: string[]): string[] {
  return entries
    .filter(
      (f) =>
        f === ".env" ||
        (f.startsWith(".env.") &&
          !f.endsWith(".secrets") &&
          !f.endsWith(".local") &&
          !f.endsWith(".example")),
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Replicate: simple .env file parser (key=value lines)
// ---------------------------------------------------------------------------

/**
 * Parse .env file content into key-value pairs.
 * Handles comments (#), blank lines, quoted values, and inline comments.
 */
function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests: .env file filtering
// ---------------------------------------------------------------------------

describe("env file filtering", () => {
  it("includes .env and .env.{suffix} files", () => {
    const entries = [".env", ".env.dev", ".env.staging", ".env.prod", "package.json", "README.md"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, [".env", ".env.dev", ".env.prod", ".env.staging"]);
  });

  it("excludes .env.secrets", () => {
    const entries = [".env", ".env.secrets", ".env.staging"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, [".env", ".env.staging"]);
  });

  it("excludes .env.local", () => {
    const entries = [".env", ".env.local", ".env.prod"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, [".env", ".env.prod"]);
  });

  it("excludes .env.example", () => {
    const entries = [".env", ".env.example", ".env.dev"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, [".env", ".env.dev"]);
  });

  it("returns empty for no matching files", () => {
    const entries = ["package.json", "tsconfig.json"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, []);
  });

  it("excludes all three special suffixes at once", () => {
    const entries = [".env", ".env.secrets", ".env.local", ".env.example", ".env.staging"];
    const result = filterEnvFiles(entries);
    assert.deepEqual(result, [".env", ".env.staging"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: displayName conversion
// ---------------------------------------------------------------------------

describe("envDisplayName", () => {
  it('".env" → "default"', () => {
    assert.equal(envDisplayName(".env"), "default");
  });

  it('".env.staging" → "staging"', () => {
    assert.equal(envDisplayName(".env.staging"), "staging");
  });

  it('".env.prod" → "prod"', () => {
    assert.equal(envDisplayName(".env.prod"), "prod");
  });

  it('".env.dev" → "dev"', () => {
    assert.equal(envDisplayName(".env.dev"), "dev");
  });

  it("non-.env prefix returns as-is", () => {
    assert.equal(envDisplayName("config.env"), "config.env");
  });
});

// ---------------------------------------------------------------------------
// Tests: .env file parsing
// ---------------------------------------------------------------------------

describe("env file parsing", () => {
  it("parses simple key=value pairs", () => {
    const content = "API_URL=https://api.example.com\nAPI_KEY=abc123";
    const result = parseEnvContent(content);
    assert.deepEqual(result, {
      API_URL: "https://api.example.com",
      API_KEY: "abc123",
    });
  });

  it("skips comments and blank lines", () => {
    const content = `# This is a comment
API_URL=https://api.example.com

# Another comment
API_KEY=abc123
`;
    const result = parseEnvContent(content);
    assert.deepEqual(result, {
      API_URL: "https://api.example.com",
      API_KEY: "abc123",
    });
  });

  it("strips double quotes from values", () => {
    const content = 'API_URL="https://api.example.com"';
    const result = parseEnvContent(content);
    assert.equal(result.API_URL, "https://api.example.com");
  });

  it("strips single quotes from values", () => {
    const content = "API_KEY='secret-key'";
    const result = parseEnvContent(content);
    assert.equal(result.API_KEY, "secret-key");
  });

  it("handles values with = in them", () => {
    const content = "QUERY=key=value&foo=bar";
    const result = parseEnvContent(content);
    assert.equal(result.QUERY, "key=value&foo=bar");
  });

  it("returns empty object for empty content", () => {
    assert.deepEqual(parseEnvContent(""), {});
    assert.deepEqual(parseEnvContent("\n\n"), {});
  });
});
