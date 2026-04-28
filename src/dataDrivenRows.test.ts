import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractTests } from "./parser";
import { materializeDataDrivenRows } from "./dataDrivenRows";

const SDK_IMPORT = 'import { test, fromCsv, fromYaml, fromDir } from "@glubean/sdk";\n';

describe("materializeDataDrivenRows", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glubean-vscode-rows-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): string {
    const filePath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function rowsFor(content: string, filePath: string, parentId: string) {
    const tests = extractTests(content);
    return materializeDataDrivenRows(content, tests, {
      filePath,
      workspaceRoot: tmpDir,
    }).rowsByParentId.get(parentId) ?? [];
  }

  it("expands test.each rows from a CSV loader", () => {
    write("tests/data/cases.csv", "id,label\n101,alpha\n102,beta\n");
    const testFile = write("tests/cases.test.ts", "");
    const content =
      SDK_IMPORT +
      `const cases = await fromCsv("./data/cases.csv");

export const csvCases = test.each(cases)(
  { id: "case-$id", name: "Case $label" },
  async () => {},
);`;

    const rows = rowsFor(content, testFile, "each:case-$id");
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, label: row.label })),
      [
        { id: "case-101", label: "Case alpha" },
        { id: "case-102", label: "Case beta" },
      ],
    );
  });

  it("expands test.pick rows from an inline object", () => {
    const testFile = write("tests/search.test.ts", "");
    const content =
      SDK_IMPORT +
      `export const search = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  { id: "search-$_pick", name: "Search $_pick" },
  async () => {},
);`;

    const rows = rowsFor(content, testFile, "pick:search-$_pick");
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, label: row.label, pickKey: row.pickKey })),
      [
        { id: "search-by-name", label: "Search by-name", pickKey: "by-name" },
        {
          id: "search-by-category",
          label: "Search by-category",
          pickKey: "by-category",
        },
      ],
    );
  });

  it("expands test.pick rows from fromYaml.map", () => {
    write(
      "data/scenarios.yaml",
      `normal:
  q: phone
edge:
  q: ""
`,
    );
    const testFile = write("tests/search.test.ts", "");
    const content =
      SDK_IMPORT +
      `const scenarios = await fromYaml.map("data/scenarios.yaml");

export const search = test.pick(scenarios)(
  { id: "search-$_pick-$q", name: "Search $_pick" },
  async () => {},
);`;

    const rows = rowsFor(content, testFile, "pick:search-$_pick-$q");
    assert.deepEqual(rows.map((row) => row.id), [
      "search-normal-phone",
      "search-edge-",
    ]);
  });

  it("expands test.each rows from fromDir with file metadata", () => {
    write("tests/data/a.json", `{"expected": 200}`);
    write("tests/data/b.json", `{"expected": 404}`);
    const testFile = write("tests/dir.test.ts", "");
    const content =
      SDK_IMPORT +
      `const cases = await fromDir("./data/");

export const dirCases = test.each(cases)(
  { id: "dir-$_name-$expected", name: "$_path" },
  async () => {},
);`;

    const rows = rowsFor(content, testFile, "each:dir-$_name-$expected");
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, label: row.label })),
      [
        { id: "dir-a-200", label: "a.json" },
        { id: "dir-b-404", label: "b.json" },
      ],
    );
  });

  it("skips rows whose id template cannot be fully resolved", () => {
    const testFile = write("tests/search.test.ts", "");
    const content =
      SDK_IMPORT +
      `export const search = test.pick({
  "by-name": { q: "phone" },
})("search-$missing-$_pick", async () => {});`;

    const rows = rowsFor(content, testFile, "pick:search-$missing-$_pick");
    assert.deepEqual(rows, []);
  });
});
