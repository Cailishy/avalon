import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exportPublicSource, publicSourceFiles } from "./export-source.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awalong-public-source-")); roots.push(root);
  const write = (name: string, content = "synthetic public fixture") => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), content); };
  for (const file of ["README.md", ".env.example", "src/index.ts", "public/assets/NOTICE.md", "docs/README.md", "docs/development/security.md", ".github/workflows/checks.yml", "deploy/.env.public.example"]) write(file);
  for (const file of [".env", ".claude/settings.json", ".git/config", ".media/private.txt", "data/rooms.db", "docs/maintainers/local.md", "docs/archive/old.md", "src/local.log", "src/.aws/credentials", "public/backup.sqlite3", "unreviewed-notes.md"]) write(file, "synthetic local-only fixture");
  return { root, write };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("awalong-public-source-")) throw new Error("Unsafe export fixture cleanup.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Public source snapshots", () => {
  it("selects only public roots and excludes local metadata, history and private files", () => {
    const { root } = fixture();
    expect(publicSourceFiles(root)).toEqual([".env.example", ".github/workflows/checks.yml", "README.md", "deploy/.env.public.example", "docs/README.md", "docs/development/security.md", "public/assets/NOTICE.md", "src/index.ts"]);
  });
  it("verifies the isolated snapshot before making it available and preserves originals", () => {
    const { root } = fixture(); let verified = false;
    const result = exportPublicSource(root, "fixture", (directory: string, files: string[]) => {
      verified = true;
      expect(existsSync(join(root, ".media/exports/fixture"))).toBe(false);
      expect(files).toHaveLength(8);
      expect(existsSync(join(directory, ".env"))).toBe(false);
      expect(existsSync(join(directory, ".git"))).toBe(false);
      expect(readFileSync(join(directory, "README.md"), "utf8")).toBe("synthetic public fixture");
    });
    expect(verified).toBe(true);
    expect(existsSync(result.directory)).toBe(true);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("synthetic local-only fixture");
  });
  it("refuses to overwrite an existing snapshot", () => {
    const { root } = fixture();
    const result = exportPublicSource(root, "fixture", () => {});
    expect(() => exportPublicSource(root, "fixture", () => {})).toThrow("already exists");
    expect(readFileSync(join(result.directory, "README.md"), "utf8")).toBe("synthetic public fixture");
  });
  it("removes its own incomplete snapshot when verification fails", () => {
    const { root } = fixture();
    expect(() => exportPublicSource(root, "fixture", () => { throw new Error("Synthetic scan failure"); })).toThrow("Synthetic scan failure");
    expect(readdirSync(join(root, ".media/exports"))).toEqual([]);
    expect(existsSync(join(root, "src/index.ts"))).toBe(true);
  });
  it.each([() => false, () => Promise.resolve()])("refuses failed or asynchronous snapshot verification", verify => {
    const { root } = fixture();
    expect(() => exportPublicSource(root, "fixture", verify)).toThrow("synchronously");
    expect(existsSync(join(root, ".media/exports/fixture"))).toBe(false);
  });
  it.each(["../outside", "a/b", "a\\b", "", "nul", "con", "Uppercase"])("rejects unsafe snapshot name %j", name => {
    const { root } = fixture();
    expect(() => exportPublicSource(root, name, () => {})).toThrow("snapshot name");
    expect(existsSync(join(root, ".media/exports"))).toBe(false);
  });
  it("requires verification and rejects unreviewed file types under public roots", () => {
    const { root, write } = fixture();
    expect(() => exportPublicSource(root, "fixture", undefined)).toThrow("verification");
    write("src/unexpected.bin");
    expect(() => publicSourceFiles(root)).toThrow("Unexpected source file type");
  });
  it("rejects linked public directories without reading their target", () => {
    const { root } = fixture();
    const elsewhere = mkdtempSync(join(tmpdir(), "awalong-public-source-")); roots.push(elsewhere);
    symlinkSync(elsewhere, join(root, "src/linked"), "junction");
    expect(() => publicSourceFiles(root)).toThrow("symlink");
  });
  it("rejects a linked export parent", () => {
    const { root } = fixture();
    const elsewhere = mkdtempSync(join(tmpdir(), "awalong-public-source-")); roots.push(elsewhere);
    symlinkSync(elsewhere, join(root, ".media/exports"), "junction");
    expect(() => exportPublicSource(root, "fixture", () => {})).toThrow("Export parent");
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
