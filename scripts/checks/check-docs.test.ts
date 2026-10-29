import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspectDocumentation } from "./check-docs.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awalong-documentation-")); roots.push(root);
  mkdirSync(join(root, "docs/guide"), { recursive: true });
  mkdirSync(join(root, "public/assets"), { recursive: true });
  writeFileSync(join(root, "README.md"), "[Guide](docs/guide/start.md#start)\n");
  writeFileSync(join(root, "docs/guide/start.md"), "[Home](../../README.md)\n");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("awalong-documentation-")) throw new Error("Unsafe documentation fixture cleanup.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Local documentation links", () => {
  it("does not read retired internal records and rejects public links to them", () => {
    const root = fixture();
    mkdirSync(join(root, "docs/maintainers"));
    writeFileSync(join(root, "docs/maintainers/local.md"), "[Private example](missing-internal.md)");
    expect(inspectDocumentation(root)).toEqual({ errors: [], documents: 2, checkedLinks: 2 });
    writeFileSync(join(root, "README.md"), "[Internal](docs/maintainers/local.md)");
    expect(inspectDocumentation(root).errors).toEqual(["Invalid local link at README.md:1: docs/maintainers/local.md"]);
  });
  it("checks nested relative links after reorganization", () => {
    expect(inspectDocumentation(fixture())).toEqual({ errors: [], documents: 2, checkedLinks: 2 });
  });
  it("reports links left at the previous path", () => {
    const root = fixture(); writeFileSync(join(root, "README.md"), "[Old](docs/OLD.md)");
    expect(inspectDocumentation(root).errors).toEqual(["Invalid local link at README.md:1: docs/OLD.md"]);
  });
  it("ignores remote URLs and anchors without network access", () => {
    const root = fixture(); writeFileSync(join(root, "README.md"), "[Web](https://invalid.example/not-fetched) [Mail](mailto:invalid@example.test) [Part](#part)");
    expect(inspectDocumentation(root)).toEqual({ errors: [], documents: 2, checkedLinks: 1 });
  });
  it("checks image references and encoded paths with spaces", () => {
    const root = fixture(); writeFileSync(join(root, "docs/guide/with space.md"), "# Page");
    writeFileSync(join(root, "README.md"), "[Page](docs/guide/with%20space.md) [Page](<docs/guide/with space.md>) ![Missing](public/assets/missing.png)");
    expect(inspectDocumentation(root).errors).toHaveLength(1);
    expect(inspectDocumentation(root).checkedLinks).toBe(3);
  });
  it("does not interpret links in fenced examples as real documents", () => {
    const root = fixture(); writeFileSync(join(root, "README.md"), "```md\n[Example](not-a-file.md)\n```\n~~~md\n[Other](not-a-file.md)\n~~~");
    expect(inspectDocumentation(root).errors).toEqual([]);
  });
  it("rejects paths escaping the repository", () => {
    const root = fixture(); writeFileSync(join(root, "README.md"), "[Outside](../outside.md)");
    expect(inspectDocumentation(root).errors).toHaveLength(1);
  });
  it("reports malformed URL encoding instead of throwing", () => {
    const root = fixture(); writeFileSync(join(root, "README.md"), "[Bad](%E0%A4%A.md)");
    expect(inspectDocumentation(root).errors).toHaveLength(1);
  });
  it("includes asset licensing documents in link checks", () => {
    const root = fixture(); writeFileSync(join(root, "public/assets/LICENSE.md"), "[Guide](../../docs/guide/start.md)");
    expect(inspectDocumentation(root)).toEqual({ errors: [], documents: 3, checkedLinks: 3 });
  });
});
