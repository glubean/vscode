import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { parse as parseYaml } from "yaml";
import { resolveDataPath } from "./data-path";
import type { TestMeta } from "./parser";

export interface DataDrivenRow {
  kind: "each" | "pick";
  parentId: string;
  id: string;
  label: string;
  exportName: string;
  pickKey?: string;
}

export interface MaterializedDataDrivenRows {
  rowsByParentId: Map<string, DataDrivenRow[]>;
  dataPaths: string[];
}

interface RowData {
  index: number;
  pickKey?: string;
  data: Record<string, unknown>;
}

type SourceRef =
  | { kind: "inline"; value: unknown }
  | { kind: "json-import"; rawPath: string }
  | { kind: "csv"; rawPath: string; separator?: string; headers?: boolean }
  | { kind: "json"; rawPath: string; pick?: string; map?: boolean }
  | { kind: "yaml"; rawPath: string; pick?: string; map?: boolean }
  | { kind: "jsonl"; rawPath: string }
  | {
      kind: "dir";
      rawPath: string;
      mode: "dir" | "concat" | "merge";
      ext?: string[];
      recursive?: boolean;
      pick?: string;
    };

interface DataCall {
  kind: "each" | "pick";
  dataArg: ts.Expression;
}

interface AstIndex {
  sourceFile: ts.SourceFile;
  jsonImports: Map<string, string>;
  bindings: Map<string, ts.Expression>;
  dataCallsByExport: Map<string, DataCall>;
}

const UNREADABLE = Symbol("unreadable");

export function materializeDataDrivenRows(
  content: string,
  tests: TestMeta[],
  options: { filePath: string; workspaceRoot: string },
): MaterializedDataDrivenRows {
  const rowsByParentId = new Map<string, DataDrivenRow[]>();
  const dataPaths = new Set<string>();
  const index = buildAstIndex(content, options.filePath);

  for (const test of tests) {
    const kind = test.id.startsWith("each:")
      ? "each"
      : test.id.startsWith("pick:")
        ? "pick"
        : undefined;
    if (!kind) continue;

    const call = index.dataCallsByExport.get(test.exportName);
    if (!call || call.kind !== kind) continue;

    const source = sourceRefFromExpression(call.dataArg, index);
    if (!source) continue;

    const resolved = readRows(source, kind, options);
    for (const dataPath of resolved.dataPaths) dataPaths.add(dataPath);
    if (resolved.rows.length === 0) continue;

    const templateId = stripDataPrefix(test.id);
    const labelTemplate = stripDataSuffix(test.name ?? templateId);
    const rows: DataDrivenRow[] = [];

    for (const row of resolved.rows) {
      const id = interpolateTemplate(templateId, row.data, row.index);
      if (hasUnresolvedTemplate(id)) continue;

      const label = interpolateTemplate(labelTemplate, row.data, row.index);
      rows.push({
        kind,
        parentId: test.id,
        id,
        label: label && !hasUnresolvedTemplate(label) ? label : id,
        exportName: test.exportName,
        ...(row.pickKey !== undefined ? { pickKey: row.pickKey } : {}),
      });
    }

    if (rows.length > 0) {
      rowsByParentId.set(test.id, rows);
    }
  }

  return { rowsByParentId, dataPaths: [...dataPaths].sort() };
}

function buildAstIndex(content: string, filePath: string): AstIndex {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const index: AstIndex = {
    sourceFile,
    jsonImports: new Map(),
    bindings: new Map(),
    dataCallsByExport: new Map(),
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const importName = node.importClause?.name;
      const modulePath = stringFromExpression(node.moduleSpecifier);
      if (importName && modulePath?.endsWith(".json")) {
        index.jsonImports.set(importName.text, modulePath);
      }
    }

    if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }

        index.bindings.set(declaration.name.text, declaration.initializer);
        if (exported) {
          const dataCall = findDataCall(declaration.initializer);
          if (dataCall) {
            index.dataCallsByExport.set(declaration.name.text, dataCall);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return index;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function findDataCall(expr: ts.Expression): DataCall | undefined {
  let found: DataCall | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "each" || callee.name.text === "pick") &&
        node.arguments.length > 0
      ) {
        found = {
          kind: callee.name.text as "each" | "pick",
          dataArg: node.arguments[0],
        };
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
  return found;
}

function sourceRefFromExpression(
  expression: ts.Expression,
  index: AstIndex,
  visited = new Set<string>(),
): SourceRef | undefined {
  const expr = unwrapExpression(expression);

  if (ts.isIdentifier(expr)) {
    const jsonPath = index.jsonImports.get(expr.text);
    if (jsonPath) return { kind: "json-import", rawPath: jsonPath };

    if (visited.has(expr.text)) return undefined;
    const bound = index.bindings.get(expr.text);
    if (!bound) return undefined;

    visited.add(expr.text);
    return sourceRefFromExpression(bound, index, visited);
  }

  if (ts.isArrayLiteralExpression(expr) || ts.isObjectLiteralExpression(expr)) {
    const value = literalValue(expr);
    return value === UNREADABLE ? undefined : { kind: "inline", value };
  }

  if (ts.isCallExpression(expr)) {
    return loaderSourceRef(expr);
  }

  return undefined;
}

function loaderSourceRef(call: ts.CallExpression): SourceRef | undefined {
  const name = loaderName(call.expression);
  if (!name) return undefined;

  const rawPath = stringFromExpression(call.arguments[0]);
  if (!rawPath) return undefined;

  const options = objectOptions(call.arguments[1]);

  switch (name) {
    case "fromCsv":
      return {
        kind: "csv",
        rawPath,
        separator: options.separator,
        headers: options.headers,
      };
    case "fromJsonl":
      return { kind: "jsonl", rawPath };
    case "fromJson":
      return { kind: "json", rawPath, pick: options.pick };
    case "fromJson.map":
      return { kind: "json", rawPath, map: true };
    case "fromYaml":
      return { kind: "yaml", rawPath, pick: options.pick };
    case "fromYaml.map":
      return { kind: "yaml", rawPath, map: true };
    case "fromDir":
      return {
        kind: "dir",
        rawPath,
        mode: "dir",
        ext: options.ext,
        recursive: options.recursive,
      };
    case "fromDir.concat":
      return {
        kind: "dir",
        rawPath,
        mode: "concat",
        ext: options.ext,
        recursive: options.recursive,
        pick: options.pick,
      };
    case "fromDir.merge":
      return {
        kind: "dir",
        rawPath,
        mode: "merge",
        ext: options.ext,
        recursive: options.recursive,
      };
  }
}

function loaderName(expression: ts.Expression): string | undefined {
  const expr = unwrapExpression(expression);
  if (ts.isIdentifier(expr)) {
    return [
      "fromCsv",
      "fromJson",
      "fromJsonl",
      "fromYaml",
      "fromDir",
    ].includes(expr.text)
      ? expr.text
      : undefined;
  }

  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = expr.expression.text;
    const prop = expr.name.text;
    const name = `${base}.${prop}`;
    return [
      "fromJson.map",
      "fromYaml.map",
      "fromDir.concat",
      "fromDir.merge",
    ].includes(name)
      ? name
      : undefined;
  }

  return undefined;
}

function objectOptions(expression: ts.Expression | undefined): {
  pick?: string;
  separator?: string;
  headers?: boolean;
  ext?: string[];
  recursive?: boolean;
} {
  const expr = expression ? unwrapExpression(expression) : undefined;
  if (!expr || !ts.isObjectLiteralExpression(expr)) return {};

  const out: ReturnType<typeof objectOptions> = {};
  for (const property of expr.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyNameText(property.name);
    if (!key) continue;

    if (key === "pick") {
      const pick = stringFromExpression(property.initializer);
      if (pick) out.pick = pick;
    } else if (key === "separator") {
      const separator = stringFromExpression(property.initializer);
      if (separator) out.separator = separator;
    } else if (key === "headers") {
      const value = booleanFromExpression(property.initializer);
      if (value !== undefined) out.headers = value;
    } else if (key === "recursive") {
      const value = booleanFromExpression(property.initializer);
      if (value !== undefined) out.recursive = value;
    } else if (key === "ext") {
      const value = stringArrayFromExpression(property.initializer);
      if (value.length > 0) out.ext = value;
    }
  }

  return out;
}

function readRows(
  source: SourceRef,
  kind: "each" | "pick",
  options: { filePath: string; workspaceRoot: string },
): { rows: RowData[]; dataPaths: string[] } {
  try {
    switch (source.kind) {
      case "inline":
        return { rows: rowsFromValue(source.value, kind), dataPaths: [] };
      case "json-import": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        return {
          rows: rowsFromValue(JSON.parse(fs.readFileSync(filePath, "utf-8")), kind),
          dataPaths: [filePath],
        };
      }
      case "csv": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const rows = parseCsv(fs.readFileSync(filePath, "utf-8"), {
          separator: source.separator,
          headers: source.headers,
        });
        return { rows: rowsFromValue(rows, kind), dataPaths: [filePath] };
      }
      case "json": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const picked = source.map ? value : pickByPath(value, source.pick);
        return { rows: rowsFromValue(picked, kind), dataPaths: [filePath] };
      }
      case "yaml": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const value = parseYaml(fs.readFileSync(filePath, "utf-8"));
        const picked = source.map ? value : pickByPath(value, source.pick);
        return { rows: rowsFromValue(picked, kind), dataPaths: [filePath] };
      }
      case "jsonl": {
        const filePath = resolveLoaderPath(source.rawPath, options);
        const rows = fs
          .readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));
        return { rows: rowsFromValue(rows, kind), dataPaths: [filePath] };
      }
      case "dir":
        return readDirRows(source, kind, options);
    }
  } catch {
    return { rows: [], dataPaths: [] };
  }
}

function readDirRows(
  source: Extract<SourceRef, { kind: "dir" }>,
  kind: "each" | "pick",
  options: { filePath: string; workspaceRoot: string },
): { rows: RowData[]; dataPaths: string[] } {
  const dirPath = resolveLoaderPath(source.rawPath, options);
  const files = collectFiles(dirPath, source.ext, source.recursive);
  const dataPaths = [...files];

  if (source.mode === "merge") {
    const merged: Record<string, unknown> = {};
    for (const file of files) {
      const value = loadSingleFile(file);
      if (isPlainObject(value)) Object.assign(merged, value);
    }
    return { rows: rowsFromValue(merged, kind), dataPaths };
  }

  if (source.mode === "concat") {
    const rows: unknown[] = [];
    for (const file of files) {
      const value = loadFileAuto(file, source.pick);
      if (Array.isArray(value)) rows.push(...value);
    }
    return { rows: rowsFromValue(rows, kind), dataPaths };
  }

  const rows = files.map((file) => {
    const content = loadSingleFile(file);
    const name = fileNameWithoutExt(file);
    const rel = path.relative(dirPath, file).replace(/\\/g, "/");
    return {
      _name: name,
      _path: rel,
      ...(isPlainObject(content) ? content : { data: content }),
    };
  });
  return { rows: rowsFromValue(rows, kind), dataPaths };
}

function resolveLoaderPath(
  rawPath: string,
  options: { filePath: string; workspaceRoot: string },
): string {
  return resolveDataPath(rawPath, {
    sourceFilePath: options.filePath,
    workspaceRoot: options.workspaceRoot,
  }).resolvedPath;
}

function collectFiles(
  dirPath: string,
  extensions: string[] | undefined,
  recursive: boolean | undefined,
): string[] {
  const wanted = (extensions && extensions.length > 0
    ? extensions
    : [".json", ".yaml", ".yml"]
  ).map((ext) => ext.toLowerCase());
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (wanted.some((ext) => lower.endsWith(ext))) {
          out.push(fullPath);
        }
      }
    }
  };

  walk(dirPath);
  return out.sort();
}

function loadFileAuto(filePath: string, pick?: string): unknown {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(fs.readFileSync(filePath, "utf-8"));
  }
  if (lower.endsWith(".jsonl")) {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }
  const value = loadSingleFile(filePath);
  return pickByPath(value, pick);
}

function loadSingleFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return parseYaml(content);
  }
  if (lower.endsWith(".csv")) {
    return parseCsv(content)[0] ?? {};
  }
  if (lower.endsWith(".jsonl")) {
    const first = content.split("\n").find((line) => line.trim() !== "");
    return first ? JSON.parse(first) : {};
  }
  return JSON.parse(content);
}

function rowsFromValue(value: unknown, kind: "each" | "pick"): RowData[] {
  if (kind === "pick") {
    if (!isPlainObject(value)) return [];
    return Object.entries(value).map(([key, row], index) => ({
      index,
      pickKey: key,
      data: rowRecord(row, key),
    }));
  }

  if (Array.isArray(value)) {
    return value.map((row, index) => ({
      index,
      data: rowRecord(row),
    }));
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, row], index) => ({
      index,
      pickKey: key,
      data: rowRecord(row, key),
    }));
  }

  return [];
}

function rowRecord(value: unknown, pickKey?: string): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(value)
    ? { ...value }
    : { value };
  if (pickKey !== undefined) base._pick = pickKey;
  return base;
}

function parseCsv(
  content: string,
  options: { separator?: string; headers?: boolean } = {},
): Record<string, string>[] {
  const separator = options.separator ?? ",";
  const hasHeaders = options.headers !== false;
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === separator) {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }

    fields.push(current.trim());
    return fields;
  };

  if (hasHeaders) {
    const headers = parseLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseLine(line);
      const record: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        record[headers[i]] = values[i] ?? "";
      }
      return record;
    });
  }

  return lines.map((line) => {
    const values = parseLine(line);
    const record: Record<string, string> = {};
    for (let i = 0; i < values.length; i++) record[String(i)] = values[i];
    return record;
  });
}

function pickByPath(value: unknown, pick: string | undefined): unknown {
  if (!pick) return value;
  let current = value;
  for (const segment of pick.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
  index: number,
): string {
  let result = template.replace(/\$index/g, String(index));
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`$${key}`, String(value));
  }
  return result;
}

function stripDataPrefix(id: string): string {
  if (id.startsWith("each:")) return id.slice("each:".length);
  if (id.startsWith("pick:")) return id.slice("pick:".length);
  return id;
}

function stripDataSuffix(name: string): string {
  return name
    .replace(/\s+\(data-driven\)$/, "")
    .replace(/\s+\(pick\)$/, "");
}

function hasUnresolvedTemplate(value: string): boolean {
  return /\$[A-Za-z_]\w*/.test(value);
}

function fileNameWithoutExt(filePath: string): string {
  const filename = path.basename(filePath);
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

function literalValue(node: ts.Expression): unknown | typeof UNREADABLE {
  const expr = unwrapExpression(node);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return undefined;

  if (
    ts.isPrefixUnaryExpression(expr) &&
    ts.isNumericLiteral(expr.operand) &&
    (expr.operator === ts.SyntaxKind.MinusToken ||
      expr.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = Number(expr.operand.text);
    return expr.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const values: unknown[] = [];
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) return UNREADABLE;
      const value = literalValue(element);
      if (value === UNREADABLE) return UNREADABLE;
      values.push(value);
    }
    return values;
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const property of expr.properties) {
      if (!ts.isPropertyAssignment(property)) return UNREADABLE;
      const key = propertyNameText(property.name);
      if (!key) return UNREADABLE;
      const value = literalValue(property.initializer);
      if (value === UNREADABLE) return UNREADABLE;
      out[key] = value;
    }
    return out;
  }

  return UNREADABLE;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringFromExpression(expression: ts.Expression | undefined): string | undefined {
  const expr = expression ? unwrapExpression(expression) : undefined;
  if (!expr) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return undefined;
}

function booleanFromExpression(expression: ts.Expression): boolean | undefined {
  const expr = unwrapExpression(expression);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function stringArrayFromExpression(expression: ts.Expression): string[] {
  const expr = unwrapExpression(expression);
  const scalar = stringFromExpression(expr);
  if (scalar) return [scalar];
  if (!ts.isArrayLiteralExpression(expr)) return [];

  const values: string[] = [];
  for (const element of expr.elements) {
    if (ts.isSpreadElement(element)) return [];
    const value = stringFromExpression(element);
    if (!value) return [];
    values.push(value);
  }
  return values;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
