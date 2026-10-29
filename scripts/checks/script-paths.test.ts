import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
function copyScript(file: string) {
  const root = mkdtempSync(join(tmpdir(), "awalong-script-paths-")); roots.push(root);
  mkdirSync(dirname(join(root, file)), { recursive: true });
  cpSync(join(source, file), join(root, file));
  return { root, file: join(root, file) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("awalong-script-paths-")) throw new Error("Unsafe script-path fixture cleanup.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Grouped tool entry points", () => {
  it("keeps every npm script target at an existing file", () => {
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    for (const command of Object.values(pkg.scripts) as string[]) for (const match of command.matchAll(/scripts\/[\w./-]+\.(?:mjs|ts)/g)) expect(existsSync(join(source, match[0])), match[0]).toBe(true);
    expect(readdirSync(join(source, "scripts"), { withFileTypes: true }).filter(item => item.isFile())).toEqual([]);
  });
  it("preserves the Docker build-script path", () => {
    const dockerfile = readFileSync(join(source, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY scripts/build/build-server.mjs ./scripts/build/build-server.mjs");
  });
  it("writes generated sounds under public/assets, not under scripts", () => {
    const fixture = copyScript("scripts/media/generate-result-sounds.mjs");
    mkdirSync(join(fixture.root, "public/assets"), { recursive: true });
    const result = spawnSync(process.execPath, [fixture.file], { cwd: fixture.root, encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["mission-success.wav", "mission-fail.wav"]) {
      const actual = createHash("sha256").update(readFileSync(join(fixture.root, "public/assets", name))).digest("hex");
      const original = createHash("sha256").update(readFileSync(join(source, "public/assets", name))).digest("hex");
      expect(actual).toBe(original);
    }
    expect(existsSync(join(fixture.root, "scripts/public"))).toBe(false);
  });
  it("creates local voice settings under the repository root only", () => {
    const fixture = copyScript("scripts/deploy/setup-voice-local.mjs");
    const result = spawnSync(process.execPath, [fixture.file], { cwd: fixture.root, encoding: "utf8", windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        LIVEKIT_API_KEY: "synthetic-local-key", LIVEKIT_API_SECRET: "synthetic-local-secret-never-used-outside-tests" } });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(fixture.root, ".media/voice.env"))).toBe(true);
    expect(existsSync(join(fixture.root, ".media/livekit.yaml"))).toBe(true);
    expect(existsSync(join(fixture.root, "scripts/.media"))).toBe(false);
  });
});
