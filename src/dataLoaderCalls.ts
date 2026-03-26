import { resolveDataPath } from "./data-path";

export interface DataLoaderCall {
  line: number;
  target: "file" | "dir";
  resolvedPath: string;
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

export function findDataLoaderCalls(
  text: string,
  options: { filePath: string; workspaceRoot: string },
): DataLoaderCall[] {
  const { filePath, workspaceRoot } = options;
  const results: DataLoaderCall[] = [];

  const GENERIC_RE = "(?:<(?:[^<>]|<[^<>]*>)*>)?";

  const dirPattern = new RegExp(
    `(?:fromDir(?:\\.merge|\\.concat)?)\\s*${GENERIC_RE}\\s*\\(\\s*["']([^"']+)["']`,
    "gs",
  );
  let match: RegExpExecArray | null;
  while ((match = dirPattern.exec(text)) !== null) {
    const rawPath = match[1];
    const resolved = resolveDataPath(rawPath, {
      sourceFilePath: filePath,
      workspaceRoot,
    }).resolvedPath;
    results.push({
      line: lineNumberAtOffset(text, match.index),
      target: "dir",
      resolvedPath: resolved,
    });
  }

  const filePattern = new RegExp(
    `(?:fromYaml(?:\\.map)?|fromJson(?:\\.map)?|fromCsv|fromJsonl)\\s*${GENERIC_RE}\\s*\\(\\s*["']([^"']+)["']`,
    "gs",
  );
  while ((match = filePattern.exec(text)) !== null) {
    const rawPath = match[1];
    const resolved = resolveDataPath(rawPath, {
      sourceFilePath: filePath,
      workspaceRoot,
    }).resolvedPath;
    results.push({
      line: lineNumberAtOffset(text, match.index),
      target: "file",
      resolvedPath: resolved,
    });
  }

  const importPattern = /import\s+\w+\s+from\s+["']([^"']+\.json)["']/g;
  while ((match = importPattern.exec(text)) !== null) {
    const rawPath = match[1];
    const resolved = resolveDataPath(rawPath, {
      sourceFilePath: filePath,
      workspaceRoot,
    }).resolvedPath;
    results.push({
      line: lineNumberAtOffset(text, match.index),
      target: "file",
      resolvedPath: resolved,
    });
  }

  return results;
}
