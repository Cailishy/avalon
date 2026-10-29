import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { forbiddenTrackedPath, inspectRepository, requiredFiles } from "./check-repository.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "awalong-repository-"));
  roots.push(root);
  for (const file of requiredFiles) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(source, file), join(root, file));
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.repository = { type: "git", url: "https://github.com/testing-team/avalon-fixture.git" };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: pkg.version, packages: { "": { version: pkg.version, license: pkg.license } } }));
  writeFileSync(join(root, "public/assets/check.png"), "synthetic-inventory-fixture");
  const record = {
    schemaVersion: 1,
    assetGroups: [{ id: "fixture-art", paths: ["public/assets/check.png"], license: "MIT", approval: "approved", reviewedBy: "Fixture maintainer", reviewedOn: "2026-10-24", evidence: ["THIRD_PARTY_NOTICES.md"], notes: "Synthetic test record, not an approval of real assets.",
      reviewedFiles: [{ file: "public/assets/check.png", bytes: Buffer.byteLength("synthetic-inventory-fixture"), sha256: createHash("sha256").update("synthetic-inventory-fixture").digest("hex") }] }],
  };
  const save = () => writeFileSync(join(root, "docs/media/assets.json"), JSON.stringify(record));
  save();
  const options = { trackedFiles: [...requiredFiles, "public/assets/check.png"], dirty: false };
  return { root, record, save, options, check: (release = false) => inspectRepository(root, { ...options, release }) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("awalong-repository-")) throw new Error("Unsafe fixture cleanup path.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Open-source repository checks", () => {
  it("accepts complete metadata and explicitly reviewed synthetic assets", () => {
    expect(fixture().check(true)).toEqual({ errors: [], warnings: [] });
  });
  it("keeps pending permissions visible in development and blocks public release", () => {
    const f = fixture();
    f.record.assetGroups[0].approval = "pending_review";
    f.save();
    expect(f.check().errors).toEqual([]);
    expect(f.check().warnings).toHaveLength(1);
    expect(f.check(true).errors).toHaveLength(1);
  });
  it.each([".env", "nested/.env.local", "deploy/.env.public", ".media/backup.sqlite", ".tools/bin.exe", ".claude/settings.local.json", ".codex/config.toml", ".codex/sessions/state.jsonl", ".agents/local.json", ".aws/credentials", "rooms.db", "backups/rooms.sqlite3", "backups/game.db-wal", "backups/rooms.sqlite3-journal", "data/rooms.sqlite-journal", "server.log", "private.key", "cert.pfx", "node_modules/a/index.js"])("rejects tracked private/generated path %s", file => {
    expect(forbiddenTrackedPath(file)).toBe(true);
  });
  it.each([".env.example", "deploy/.env.public.example", "src/server/config.ts", ".github/workflows/ci.yml", "public/assets/ATTRIBUTION.md", "docs/media/assets.json"])("preserves intentional public file %s", file => {
    expect(forbiddenTrackedPath(file)).toBe(false);
  });
  it("fails when a private file is tracked without reading its contents", () => {
    const f = fixture(); f.options.trackedFiles.push(".env");
    expect(f.check().errors.some(error => error.includes("Private/generated path"))).toBe(true);
  });
  it("rejects malformed or duplicate-key YAML", () => {
    const f = fixture();
    const file = join(f.root, ".github/ISSUE_TEMPLATE/bug_report.yml");
    writeFileSync(file, readFileSync(file, "utf8") + "\nname: duplicate\n");
    expect(f.check().errors).toContain("Invalid YAML: .github/ISSUE_TEMPLATE/bug_report.yml");
  });
  it("rejects duplicate form IDs", () => {
    const f = fixture();
    const file = join(f.root, ".github/ISSUE_TEMPLATE/bug_report.yml");
    const form = parse(readFileSync(file, "utf8"));
    form.body[2].id = form.body[1].id;
    writeFileSync(file, stringify(form));
    expect(f.check().errors.some(error => error.includes("Invalid/duplicate form id"))).toBe(true);
  });
  it("requires the actual project files and consistent lockfile licensing", () => {
    const f = fixture(); rmSync(join(f.root, "LICENSE"));
    writeFileSync(join(f.root, "package-lock.json"), JSON.stringify({ version: "0.0.0", packages: { "": { license: "UNLICENSED" } } }));
    expect(f.check().errors).toContain("Missing regular project file: LICENSE");
    expect(f.check().errors.some(error => error.includes("lockfile root"))).toBe(true);
  });
  it.each(["https://registry.npmmirror.com/check/-/check-1.0.0.tgz", "http://registry.npmjs.org/check/-/check-1.0.0.tgz", "https://user:synthetic@registry.npmjs.org/check/-/check-1.0.0.tgz", "file:../private"])("rejects non-official or credential-bearing package resolution %s", resolved => {
    const f = fixture();
    const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
    lock.packages["node_modules/check"] = { resolved, integrity: "sha512-synthetic" };
    writeFileSync(join(f.root, "package-lock.json"), JSON.stringify(lock));
    expect(f.check().errors).toContain("Package resolution must use the official HTTPS registry and integrity: node_modules/check");
  });
  it("requires integrity for official registry packages", () => {
    const f = fixture();
    const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
    lock.packages["node_modules/check"] = { resolved: "https://registry.npmjs.org/check/-/check-1.0.0.tgz" };
    writeFileSync(join(f.root, "package-lock.json"), JSON.stringify(lock));
    expect(f.check().errors).toHaveLength(1);
  });
  it("does not let new or multiply matched media bypass permission review", () => {
    const f = fixture(); writeFileSync(join(f.root, "public/assets/new.wav"), "synthetic");
    expect(f.check().errors.some(error => error.includes("new.wav"))).toBe(true);
    f.record.assetGroups.push({ ...f.record.assetGroups[0], id: "overlapping-art" }); f.save();
    expect(f.check().errors.some(error => error.includes("check.png"))).toBe(true);
  });
  it("rejects incomplete approval records and invalid dates", () => {
    const f = fixture(); f.record.assetGroups[0].reviewedOn = "2026-02-30"; f.save();
    expect(f.check(true).errors.some(error => error.includes("valid date"))).toBe(true);
    f.record.assetGroups[0].reviewedOn = "2026-10-24";
    f.record.assetGroups[0].evidence = ["../outside-private-evidence"]; f.save();
    expect(f.check().errors.some(error => error.includes("Missing local evidence"))).toBe(true);
  });
  it.each(["https://user:password@github.com/testing-team/avalon-fixture", "https://github.com/owner/example", "https://github.com/testing-team/avalon-fixture?token=synthetic"])("rejects unsafe repository metadata %s", repository => {
    const f = fixture();
    const pkg = JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"));
    pkg.repository = repository;
    writeFileSync(join(f.root, "package.json"), JSON.stringify(pkg));
    expect(f.check().errors.some(error => error.startsWith("repository must"))).toBe(true);
  });
  it.each([".claude/settings.json", "docs/maintainers/release-readiness.json", "docs/archive/comparison.md"])("keeps local maintenance files out of public source: %s", file => {
    expect(forbiddenTrackedPath(file)).toBe(true);
  });
  it("allows a local deletion in development but blocks its tracked version from release", () => {
    const f = fixture(); f.options.trackedFiles.push(".claude/settings.json");
    expect(f.check().errors).toEqual([]);
    expect(f.check().warnings).toHaveLength(1);
    expect(f.check(true).errors.some(error => error.includes("Private/generated path"))).toBe(true);
  });
  it("blocks untracked required files and dirty release checkouts without modifying Git", () => {
    const f = fixture(); f.options.trackedFiles = []; f.options.dirty = true;
    const result = f.check(true);
    expect(result.errors.some(error => error.includes("not tracked"))).toBe(true);
    expect(result.errors.some(error => error.includes("clean committed checkout"))).toBe(true);
  });
  it("does not reuse approval after a same-name asset changes", () => {
    const f = fixture(); writeFileSync(join(f.root, "public/assets/check.png"), "replacement-fixture");
    expect(f.check().errors).toContain("Reviewed asset changed; repeat source/license review: public/assets/check.png");
  });
  it("requires explicit hash coverage for all files under an approved directory", () => {
    const f = fixture(); f.record.assetGroups[0].paths = ["public/assets/"]; f.save();
    writeFileSync(join(f.root, "public/assets/new.wav"), "synthetic");
    expect(f.check().errors).toContain("Asset is not in the approved hash inventory: public/assets/new.wav");
  });
  it("rejects empty, duplicate and out-of-group approval inventory entries", () => {
    const f = fixture(); const group = f.record.assetGroups[0];
    group.reviewedFiles.push({ ...group.reviewedFiles[0] }); f.save();
    expect(f.check().errors).toContain("Invalid or duplicate reviewed file in group: fixture-art");
    group.reviewedFiles = []; f.save();
    expect(f.check().errors).toContain("Approved group requires a reviewed file/hash inventory: fixture-art");
    group.reviewedFiles.push({ file: "README.md", bytes: 1, sha256: "0".repeat(64) }); f.save();
    expect(f.check().errors).toContain("Invalid or duplicate reviewed file in group: fixture-art");
  });
  it("preserves licensing scope and generated-media provenance when rebuilding attribution", () => {
    const f = fixture();
    const script = join(f.root, "scripts/media/download-assets.mjs");
    mkdirSync(dirname(script), { recursive: true });
    cpSync(join(source, "scripts/media/download-assets.mjs"), script);
    const attribution = join(f.root, "public/assets/ATTRIBUTION.md");
    const originalTail = readFileSync(attribution, "utf8").match(/^## Generated Art[\s\S]*$/m)?.[0];
    expect(originalTail).toBeTruthy();
    // An existing synthetic cache prevents any network request or real-asset modification.
    writeFileSync(join(f.root, "public/assets/game-investigation-loop.ogg"), "synthetic-cache");
    const result = spawnSync(process.execPath, [script, "game-investigation-loop.ogg"], { cwd: f.root, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    const updated = readFileSync(attribution, "utf8");
    expect(updated).toContain("not an automatic relicensing of this media");
    expect(updated).toContain("../../docs/media/assets.json");
    expect(updated.endsWith(originalTail!)).toBe(true);
  });
});
