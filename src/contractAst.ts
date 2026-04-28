import * as ts from "typescript";

export interface AstContractCase {
  key: string;
  line: number; // 1-based
  deferred?: string;
  deprecated?: string;
  requires?: string;
  defaultRun?: string;
}

export interface AstContract {
  exportName: string;
  line: number; // 1-based export name line
  contractId: string;
  endpoint?: string;
  cases: AstContractCase[];
}

export interface AstFlow {
  exportName: string;
  line: number; // 1-based export name line
  flowId: string;
  skip?: string;
}

export interface BootstrapMarker {
  /** The exporting variable name in the .bootstrap.ts file (e.g. `meAuthorizedOverlay`). */
  exportName: string;
  /** 1-based line number where `export const X = contract.bootstrap(...)` starts. */
  exportLine: number;
  /** Local identifier referenced via `IDENT.case("KEY")` (e.g. `getMe`). */
  targetIdent: string;
  /** The case key (e.g. `authorized`) referenced via `.case("KEY")`. */
  caseKey: string;
}

export function extractMarkedContracts(content: string, filePath = "input.ts"): AstContract[] {
  return extractContracts(content, filePath, true);
}

export function extractContracts(content: string, filePath = "input.ts", requireMarker = false): AstContract[] {
  const source = parseSource(content, filePath);
  const contracts: AstContract[] = [];

  forEachExportedConst(source, (statement, declaration) => {
    if (requireMarker && !hasLeadingMarker(source, statement, "contract")) return;
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return;

    const spec = readContractCall(source, declaration.initializer);
    if (!spec) return;

    contracts.push({
      exportName: declaration.name.text,
      line: lineOf(source, declaration.name),
      contractId: spec.contractId,
      endpoint: stringProperty(source, spec.spec, "endpoint"),
      cases: readCases(source, spec.spec),
    });
  });

  return contracts;
}

export function extractMarkedFlows(content: string, filePath = "input.ts"): AstFlow[] {
  const source = parseSource(content, filePath);
  const flows: AstFlow[] = [];

  forEachExportedConst(source, (statement, declaration) => {
    if (!hasLeadingMarker(source, statement, "flow")) return;
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return;

    const flowCall = findPropertyCall(declaration.initializer, "flow");
    const flowId = flowCall ? stringFromExpression(flowCall.arguments[0]) : undefined;
    if (!flowId) return;

    const metaCall = findPropertyCall(declaration.initializer, "meta");
    const meta = metaCall ? objectFromExpression(metaCall.arguments[0]) : undefined;

    flows.push({
      exportName: declaration.name.text,
      line: lineOf(source, declaration.name),
      flowId,
      skip: meta ? stringProperty(source, meta, "skip") : undefined,
    });
  });

  return flows;
}

export function extractBootstrapMarkers(content: string, filePath = "input.ts"): BootstrapMarker[] {
  const source = parseSource(content, filePath);
  const markers: BootstrapMarker[] = [];

  forEachExportedConst(source, (_statement, declaration) => {
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return;

    const bootstrapCall = findPropertyCall(declaration.initializer, "bootstrap");
    if (!bootstrapCall) return;

    const firstArg = unwrapExpression(bootstrapCall.arguments[0]);
    if (!firstArg || !ts.isCallExpression(firstArg)) return;
    if (!ts.isPropertyAccessExpression(firstArg.expression)) return;
    if (firstArg.expression.name.text !== "case") return;
    if (!ts.isIdentifier(firstArg.expression.expression)) return;

    const caseKey = stringFromExpression(firstArg.arguments[0]);
    if (!caseKey) return;

    markers.push({
      exportName: declaration.name.text,
      exportLine: lineOf(source, declaration.name),
      targetIdent: firstArg.expression.expression.text,
      caseKey,
    });
  });

  return markers;
}

export function findImportPath(
  content: string,
  localIdent: string,
  filePath = "input.ts",
): { path: string; originalName: string } | undefined {
  const source = parseSource(content, filePath);

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const path = stringFromExpression(statement.moduleSpecifier);
    if (!path) continue;

    for (const element of statement.importClause.namedBindings.elements) {
      if (element.name.text !== localIdent) continue;
      return {
        path,
        originalName: element.propertyName?.text ?? element.name.text,
      };
    }
  }

  return undefined;
}

export function findContractIdInTarget(
  content: string,
  exportName: string,
  filePath = "input.ts",
): string | undefined {
  const source = parseSource(content, filePath);

  let contractId: string | undefined;
  forEachExportedConst(source, (_statement, declaration) => {
    if (contractId) return;
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return;
    if (declaration.name.text !== exportName) return;
    contractId = readContractCall(source, declaration.initializer)?.contractId;
  });

  return contractId;
}

function parseSource(content: string, filePath: string): ts.SourceFile {
  const kind =
    filePath.endsWith(".js") || filePath.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : filePath.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : filePath.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS;

  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
}

function forEachExportedConst(
  source: ts.SourceFile,
  cb: (statement: ts.VariableStatement, declaration: ts.VariableDeclaration) => void,
): void {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;

    for (const declaration of statement.declarationList.declarations) {
      cb(statement, declaration);
    }
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function hasLeadingMarker(source: ts.SourceFile, node: ts.Node, marker: "contract" | "flow"): boolean {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const markerRe = new RegExp(String.raw`^\s*//\s*@${marker}\s*$`);

  return ranges.some((range) => {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return false;
    const text = source.text.slice(range.pos, range.end);
    return markerRe.test(text);
  });
}

function readContractCall(
  source: ts.SourceFile,
  expression: ts.Expression,
): { contractId: string; spec: ts.ObjectLiteralExpression } | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped || !ts.isCallExpression(unwrapped)) return undefined;

  const contractId = stringFromExpression(unwrapped.arguments[0]);
  const spec = objectFromExpression(unwrapped.arguments[1]);
  if (!contractId || !spec) return undefined;
  if (!objectProperty(spec, "cases")) return undefined;

  return { contractId, spec };
}

function readCases(source: ts.SourceFile, spec: ts.ObjectLiteralExpression): AstContractCase[] {
  const casesProp = objectProperty(spec, "cases");
  if (!casesProp || !ts.isPropertyAssignment(casesProp)) return [];
  const casesObject = objectFromExpression(casesProp.initializer);
  if (!casesObject) return [];

  const cases: AstContractCase[] = [];
  for (const property of casesObject.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const key = propertyNameText(source, property.name);
    if (!key) continue;

    const inline =
      ts.isPropertyAssignment(property)
        ? objectFromExpression(property.initializer)
        : undefined;

    const caseMeta: AstContractCase = {
      key,
      line: lineOf(source, property.name),
    };

    if (inline) {
      const deferred = stringProperty(source, inline, "deferred");
      const deprecated = stringProperty(source, inline, "deprecated");
      const requires = stringProperty(source, inline, "requires");
      const defaultRun = stringProperty(source, inline, "defaultRun");
      if (deferred) caseMeta.deferred = deferred;
      if (deprecated) caseMeta.deprecated = deprecated;
      if (requires) caseMeta.requires = requires;
      if (defaultRun) caseMeta.defaultRun = defaultRun;
    }

    cases.push(caseMeta);
  }

  return cases;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => propertyNameText(undefined, property.name) === name);
}

function stringProperty(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  name: string,
): string | undefined {
  const property = objectProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  return stringFromExpression(property.initializer);
}

function propertyNameText(
  source: ts.SourceFile | undefined,
  name: ts.PropertyName | undefined,
): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return stringFromExpression(name.expression);
  return source ? name.getText(source) : undefined;
}

function stringFromExpression(expression: ts.Expression | undefined): string | undefined {
  const unwrapped = expression ? unwrapExpression(expression) : undefined;
  if (!unwrapped) return undefined;
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function objectFromExpression(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  const unwrapped = expression ? unwrapExpression(expression) : undefined;
  return unwrapped && ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
}

function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
  return current;
}

function findPropertyCall(expression: ts.Node, name: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(expression);
  return found;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
