/**
 * Minimal .env file parser for loading test execution context.
 * Parses KEY=VALUE lines, ignoring comments and empty lines.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Parse .env file content into a key-value record.
 * Handles: KEY=VALUE, KEY="VALUE", KEY='VALUE', # comments, empty lines.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
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

async function tryReadEnv(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseEnvContent(content);
  } catch {
    return {};
  }
}

/**
 * Load project environment from .env + .env.secrets files.
 * Returns { vars, secrets } for ExecutionContext.
 */
export async function loadProjectEnv(
  rootDir: string,
  envFile = ".env",
): Promise<{ vars: Record<string, string>; secrets: Record<string, string> }> {
  const vars = await tryReadEnv(join(rootDir, envFile));

  // Derive secrets file name: .env → .env.secrets, .env.staging → .env.staging.secrets
  const secretsFile = envFile === ".env" ? ".env.secrets" : `${envFile}.secrets`;
  const secrets = await tryReadEnv(join(rootDir, secretsFile));

  // Expand ${NAME} references: same-file values first, then process.env
  const merged = { ...vars, ...secrets };
  const expanded = expandVars(merged);

  // Split back into vars and secrets based on original keys
  const expandedVars: Record<string, string> = {};
  const expandedSecrets: Record<string, string> = {};
  for (const key of Object.keys(vars)) {
    expandedVars[key] = expanded[key];
  }
  for (const key of Object.keys(secrets)) {
    expandedSecrets[key] = expanded[key];
  }

  return { vars: expandedVars, secrets: expandedSecrets };
}

/**
 * Expand `${NAME}` references in env values.
 * Lookup: already-resolved values → process.env → empty string.
 */
export function expandVars(vars: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      return result[name] ?? process.env[name] ?? "";
    });
  }
  return result;
}
