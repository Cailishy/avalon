import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createDeploymentFile, deploymentDefaults, inspectDeployment, parseDeploymentEnv, readDeploymentFile, renderCaddy, writeCaddyDirectory } from "./deployment.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "awalong-deployment-")); roots.push(root); return root; }
function valid() {
  return { ...deploymentDefaults, COMPOSE_PROJECT_NAME: "avalon-test", GAME_IMAGE: "avalon:fixture-v1", GAME_DOMAIN: "game.deployment-fixture.org", PUBLIC_ORIGIN: "https://game.deployment-fixture.org",
    GAME_ACCESS_CODE: "synthetic-only-passcode-for-deployment-checks", ROOM_STORE_PATH: "/app/data/rooms.sqlite", VOICE_REQUIRED: "false", TLS_EMAIL: "ops@deployment-fixture.org" };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("awalong-deployment-")) throw new Error("Unsafe deployment fixture cleanup.");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Deployment configuration", () => {
  it.each(["host", "container", "standalone"])("accepts a complete %s deployment without exposing credentials", gateway => {
    const values = valid(), result = inspectDeployment(values, { gateway });
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(values.GAME_ACCESS_CODE);
    expect(result.settings.domain).toBe(values.GAME_DOMAIN);
  });
  it("parses comments and literal quoted values without variable substitution", () => {
    const values = parseDeploymentEnv("# comment\r\nGAME_DOMAIN=game.deployment-fixture.org\r\nGAME_ACCESS_CODE='synthetic # value'\n");
    expect(values.GAME_ACCESS_CODE).toBe("synthetic # value");
    expect(Object.getPrototypeOf(values)).toBeNull();
  });
  it.each(["GAME_DOMAIN=a\nGAME_DOMAIN=b", "GAME_DOMAIN=${PRIVATE_VALUE}", "GAME_DOMAIN='unterminated", "export GAME_DOMAIN=bad", "TRUST_PROXY_CIDRS=0.0.0.0/0", "GAME_ACCESS_CODE=x\u0000y", "OTHER_SETTING=secret"])("rejects ambiguous or unsupported input without echoing its value", text => {
    expect(() => parseDeploymentEnv(text)).toThrow();
  });
  it("limits private configuration size", () => { expect(() => parseDeploymentEnv("#".repeat(32769))).toThrow("32 KiB"); });
  it("rejects control characters introduced by quoted escapes", () => {
    expect(() => parseDeploymentEnv('GAME_ACCESS_CODE="synthetic\\nsecond-line"')).toThrow("single-line");
  });
  it.each(["GAME_ACCESS_CODE=synthetic#suffix", "GAME_DOMAIN=value # inline comment", "GAME_ACCESS_CODE='first'ignored'", "GAME_ACCESS_CODE='path\\to\\value'"])("rejects parser differences in %s", text => {
    expect(() => parseDeploymentEnv(text)).toThrow();
  });
  it.each(["game.example.com", "127.0.0.1", "*.deployment-fixture.org", "https://game.deployment-fixture.org", "Game.deployment-fixture.org", "bad.org {\nrespond 200\n}"])("refuses unsafe domain %s", domain => {
    expect(inspectDeployment({ ...valid(), GAME_DOMAIN: domain }).errors.some(value => value.includes("GAME_DOMAIN"))).toBe(true);
  });
  it.each(["http://game.deployment-fixture.org", "https://other.deployment-fixture.org", "https://game.deployment-fixture.org/path", "https://game.deployment-fixture.org?token=synthetic"])("requires matching exact HTTPS origin %s", origin => {
    expect(inspectDeployment({ ...valid(), PUBLIC_ORIGIN: origin }).errors.some(value => value.includes("PUBLIC_ORIGIN"))).toBe(true);
  });
  it.each(["0", "443", "65536", "3100/tcp", "NaN"])("refuses invalid loopback port %s", port => {
    expect(inspectDeployment({ ...valid(), GAME_HTTP_PORT: port }).errors.some(value => value.includes("GAME_HTTP_PORT"))).toBe(true);
  });
  it.each(["/tmp/rooms.sqlite", "/app/data/../rooms.sqlite", "/app/data/nested/rooms.sqlite", "/app/data/rooms.txt"])("requires a persistent container database path %s", file => {
    expect(inspectDeployment({ ...valid(), ROOM_STORE_PATH: file }).errors.some(value => value.includes("ROOM_STORE_PATH"))).toBe(true);
  });
  it.each(["0.0.0.0/0", "8.8.8.0/24", "172.30.70.1/24", "172.30.70.0/31", "192.168.0.0/15", "172.32.0.0/24", "::1/128"])("refuses unsafe or inconsistent subnet %s", subnet => {
    expect(inspectDeployment({ ...valid(), GAME_NETWORK_SUBNET: subnet }).errors.length).toBeGreaterThan(0);
  });
  it("validates changed subnets, distinct hosts and reserved network/broadcast addresses", () => {
    const values = { ...valid(), GAME_NETWORK_SUBNET: "10.80.20.0/24", GAME_NETWORK_GATEWAY: "10.80.20.1", GAME_CADDY_IP: "10.80.20.2", GAME_APP_IP: "10.80.20.3" };
    expect(inspectDeployment(values).errors).toEqual([]);
    for (const ip of ["10.80.21.3", "10.80.20.0", "10.80.20.255", "10.80.20.1", "not-an-ip"]) expect(inspectDeployment({ ...values, GAME_APP_IP: ip }).errors.length).toBeGreaterThan(0);
  });
  it("accounts for Compose shell overrides and an accidentally enabled standalone gateway", () => {
    const result = inspectDeployment(valid(), { hostEnv: { GAME_HTTP_PORT: "3201", GAME_DOMAIN: "wrong.deployment-fixture.org", COMPOSE_PROFILES: "standalone" } });
    expect(result.settings.port).toBe(3201);
    expect(result.errors.some(value => value.includes("PUBLIC_ORIGIN"))).toBe(true);
    expect(result.errors.some(value => value.includes("COMPOSE_PROFILES"))).toBe(true);
    expect(result.warnings.some(value => value.includes("Shell overrides"))).toBe(true);
  });
  it("detects mismatched interpolation and container environment files", () => {
    const file = join(temporary(), ".env.public");
    expect(inspectDeployment(valid(), { envFile: file }).errors.some(value => value.includes("GAME_ENV_FILE"))).toBe(true);
    expect(inspectDeployment({ ...valid(), GAME_ENV_FILE: file }, { envFile: file }).errors).toEqual([]);
  });
  it("requires real standalone email but does not change the existing Caddy email", () => {
    expect(inspectDeployment({ ...valid(), TLS_EMAIL: "admin@example.com" }, { gateway: "standalone" }).errors.some(value => value.includes("TLS_EMAIL"))).toBe(true);
    expect(inspectDeployment({ ...valid(), TLS_EMAIL: "" }).errors).toEqual([]);
  });
  it("validates optional voice, preserving the independent private API origin", () => {
    const values = { ...valid(), LIVEKIT_URL: "wss://voice.deployment-fixture.org", LIVEKIT_API_URL: "http://10.80.20.4:7880", LIVEKIT_API_KEY: "synthetic-media-key", LIVEKIT_API_SECRET: "synthetic-media-secret-not-for-real-deployment" };
    const result = inspectDeployment(values);
    expect(result.errors).toEqual([]);
    expect(result.settings.voiceEnabled).toBe(true);
    expect(result.warnings.some(value => value.includes("credentials use HTTP"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(values.LIVEKIT_API_SECRET);
    expect(inspectDeployment({ ...values, LIVEKIT_API_URL: "https://voice.deployment-fixture.org?token=synthetic" }).errors.length).toBeGreaterThan(0);
    expect(inspectDeployment({ ...valid(), LIVEKIT_URL: values.LIVEKIT_URL }).errors.length).toBeGreaterThan(0);
    expect(inspectDeployment({ ...valid(), VOICE_REQUIRED: "true" }).errors.length).toBeGreaterThan(0);
  });
  it("generates a private random configuration exclusively and never replaces an existing file", () => {
    const file = join(temporary(), "deploy/.env.public");
    createDeploymentFile(file, { domain: valid().GAME_DOMAIN });
    const original = readFileSync(file, "utf8"), values = readDeploymentFile(file);
    expect(values.GAME_ACCESS_CODE).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inspectDeployment(values).errors).toEqual([]);
    if (process.platform !== "win32") expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(() => createDeploymentFile(file, { domain: valid().GAME_DOMAIN })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
    const other = join(temporary(), ".env.public"); createDeploymentFile(other, { domain: valid().GAME_DOMAIN });
    expect(readDeploymentFile(other).GAME_ACCESS_CODE).not.toBe(values.GAME_ACCESS_CODE);
  });
  it("does not create files from an unsafe domain or port", () => {
    const file = join(temporary(), ".env.public");
    expect(() => createDeploymentFile(file, { domain: "bad.org { respond 200 }" })).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(() => createDeploymentFile(join(temporary(), "public/.env.public"), { domain: valid().GAME_DOMAIN })).toThrow("private");
    expect(() => createDeploymentFile(join(temporary(), "README.md"), { domain: valid().GAME_DOMAIN })).toThrow("private");
    expect(() => createDeploymentFile(join(temporary(), ".env.public.example"), { domain: valid().GAME_DOMAIN })).toThrow("private");
    expect(() => createDeploymentFile(file, { domain: valid().GAME_DOMAIN, port: "443" })).toThrow();
    expect(existsSync(file)).toBe(false);
  });
  it.skipIf(process.platform === "win32")("rejects loose POSIX permissions", () => {
    const file = join(temporary(), ".env.public"); createDeploymentFile(file, { domain: valid().GAME_DOMAIN }); chmodSync(file, 0o644);
    expect(() => readDeploymentFile(file)).toThrow("chmod 600");
  });
  it("renders only a bounded site/upstream and does not write secrets or replace existing outputs", () => {
    const result = inspectDeployment(valid());
    expect(renderCaddy(result.settings)).toContain("import avalon_game 127.0.0.1:3100");
    expect(renderCaddy(result.settings, "container")).toContain("import avalon_game 172.30.70.3:3000");
    expect(() => renderCaddy({ ...result.settings, domain: "bad.org { respond 200 }" })).toThrow();
    const target = join(temporary(), "generated"); writeCaddyDirectory(target, result.settings);
    const fragment = readFileSync(join(target, "Caddyfile.existing"), "utf8");
    expect(fragment).not.toContain(valid().GAME_ACCESS_CODE);
    expect(readFileSync(join(target, "caddy-policy.caddy"), "utf8")).toBe(readFileSync(join(source, "deploy/caddy-policy.caddy"), "utf8"));
    expect(() => writeCaddyDirectory(target, result.settings)).toThrow("already exists");
    expect(readFileSync(join(target, "Caddyfile.existing"), "utf8")).toBe(fragment);
  });
  it("keeps Compose interpolation defaults aligned, loopback-only and single-writer", () => {
    const text = readFileSync(join(source, "deploy/compose.yaml"), "utf8"), compose = parse(text);
    for (const [key, value] of Object.entries(deploymentDefaults)) expect(text).toContain(`\${${key}:-${value}}`);
    expect(compose.services.app.ports).toEqual(["127.0.0.1:${GAME_HTTP_PORT:-3100}:3000"]);
    expect(compose.services.caddy.profiles).toEqual(["standalone"]);
    expect(compose.services.app.volumes).toEqual(["app_data:/app/data"]);
    expect(compose.services.app.read_only).toBe(true);
    const restore = parse(readFileSync(join(source, "deploy/compose.restore.yaml"), "utf8"));
    expect(restore.volumes.app_data.external).toBe(true);
    expect(restore.volumes.app_data.name).toContain("${RESTORE_VOLUME:?");
    expect(compose.volumes.app_data?.external).toBeUndefined();
  });
  it("fails safely on the example through the actual CLI without leaking provided secrets", () => {
    const directory = temporary(), file = join(directory, ".env.public");
    mkdirSync(join(directory, "out"));
    const text = Object.entries({ ...valid(), PUBLIC_ORIGIN: "http://wrong.deployment-fixture.org" }).map(([key, value]) => `${key}=${value}`).join("\n");
    writeFileSync(file, text, { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", "tsx", join(source, "scripts/deploy/deployment.mjs"), "check", "--env-file", file], { cwd: source, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(valid().GAME_ACCESS_CODE);
    expect(result.stderr).toContain("PUBLIC_ORIGIN");
  });
  it("checks generated settings through the actual CLI without changing the file", () => {
    const file = join(temporary(), ".env.public"); createDeploymentFile(file, { domain: valid().GAME_DOMAIN });
    const original = readFileSync(file, "utf8");
    const env = { ...process.env };
    for (const key of [...Object.keys(deploymentDefaults), "GAME_DOMAIN", "TLS_EMAIL", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"]) delete env[key];
    const result = spawnSync(process.execPath, ["--import", "tsx", join(source, "scripts/deploy/deployment.mjs"), "check", "--env-file", file], { cwd: source, env, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("offline validation");
    expect(result.stdout + result.stderr).not.toContain(parseDeploymentEnv(original).GAME_ACCESS_CODE);
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});
