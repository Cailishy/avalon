import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { readConfig } from "../../src/server/config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const deploymentDefaults = {
  GAME_ENV_FILE: ".env.public", GAME_IMAGE: "avalon:local", GAME_HTTP_PORT: "3100", GAME_NETWORK_SUBNET: "172.30.70.0/24",
  GAME_NETWORK_GATEWAY: "172.30.70.1", GAME_CADDY_IP: "172.30.70.2", GAME_APP_IP: "172.30.70.3",
};
const composeKeys = [...Object.keys(deploymentDefaults), "GAME_DOMAIN", "TLS_EMAIL", "COMPOSE_PROJECT_NAME"];
const allowedKeys = new Set([...composeKeys, "PUBLIC_ORIGIN", "GAME_ACCESS_CODE", "ROOM_STORE_PATH", "VOICE_REQUIRED", "LIVEKIT_URL", "LIVEKIT_API_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]);
const gateways = ["host", "container", "standalone"];

export function parseDeploymentEnv(text) {
  if (Buffer.byteLength(text) > 32768) throw new Error("Deployment settings exceed 32 KiB.");
  const values = Object.create(null);
  for (const [index, line] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid assignment on line ${index + 1}; use one KEY=value per line.`);
    const [, key, raw] = match;
    if (!allowedKeys.has(key)) throw new Error(`Unsupported deployment key on line ${index + 1}.`);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate setting: ${key}.`);
    if (raw.includes("$") || raw.includes("\\") || /[\x00-\x1f\x7f]/.test(raw)) throw new Error(`Use a literal single-line value without interpolation or backslash escapes: ${key}.`); // eslint-disable-line no-control-regex -- Configuration must not contain control bytes.
    const quoted = raw.startsWith("'") || raw.startsWith('"');
    if (quoted && (raw.length < 2 || !raw.endsWith(raw[0]) || raw.slice(1, -1).includes(raw[0]))) throw new Error(`Use one complete pair of quotes: ${key}.`);
    if (!quoted && raw.includes("#")) throw new Error(`Quote values containing #; inline comments are not supported: ${key}.`);
    const parsed = parseEnv(line);
    if (!Object.hasOwn(parsed, key)) throw new Error(`Cannot parse setting: ${key}.`);
    // Quoted escape sequences must not silently produce multiline credentials.
    if (/[\x00-\x1f\x7f]/.test(parsed[key])) throw new Error(`Use a single-line value: ${key}.`); // eslint-disable-line no-control-regex -- Reject controls after parsing, too.
    values[key] = parsed[key];
  }
  return values;
}

const validDomain = value => typeof value === "string" && value.length <= 253 && value === value.toLowerCase()
  && value.split(".").length >= 2 && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  && !isIP(value) && !/(?:^|\.)example\.(?:com|net|org)$|\.(?:test|invalid|localhost|local|internal)$/.test(value);
const ipv4Number = value => value.split(".").reduce((number, part) => number * 256 + Number(part), 0);
const privateIPv4 = number => (number >= ipv4Number("10.0.0.0") && number <= ipv4Number("10.255.255.255"))
  || (number >= ipv4Number("172.16.0.0") && number <= ipv4Number("172.31.255.255"))
  || (number >= ipv4Number("192.168.0.0") && number <= ipv4Number("192.168.255.255"));

export function inspectDeployment(values, { gateway = "host", hostEnv = {}, envFile } = {}) {
  const errors = [], warnings = [];
  const effective = { ...values };
  for (const key of composeKeys) if (hostEnv[key] !== undefined) {
    effective[key] = hostEnv[key];
    if (hostEnv[key] !== values[key]) warnings.push(`Shell overrides the deployment file: ${key}.`);
  }
  for (const [key, value] of Object.entries(deploymentDefaults)) effective[key] ||= value;
  if (envFile && path.resolve(root, "deploy", effective.GAME_ENV_FILE) !== path.resolve(envFile)) errors.push("GAME_ENV_FILE must resolve to the same file passed to --env-file; Compose resolves it relative to deploy/compose.yaml.");
  if (!gateways.includes(gateway)) errors.push("Gateway must be host, container or standalone.");
  if (hostEnv.COMPOSE_PROFILES?.split(",").includes("standalone") && gateway !== "standalone") errors.push("COMPOSE_PROFILES enables another Caddy; unset it when using an existing gateway.");
  if (!validDomain(effective.GAME_DOMAIN)) errors.push("GAME_DOMAIN must be a real lowercase DNS domain, not an IP, wildcard or example domain.");
  try {
    const origin = new URL(values.PUBLIC_ORIGIN);
    if (origin.protocol !== "https:" || origin.host !== effective.GAME_DOMAIN || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error();
  } catch { errors.push("PUBLIC_ORIGIN must match https://GAME_DOMAIN without a path, query or credentials."); }
  if (!/^\d+$/.test(effective.GAME_HTTP_PORT) || Number(effective.GAME_HTTP_PORT) < 1024 || Number(effective.GAME_HTTP_PORT) > 65535) errors.push("GAME_HTTP_PORT must be an unprivileged port from 1024 to 65535.");
  if (!effective.COMPOSE_PROJECT_NAME) warnings.push("Record the existing Compose project name before upgrading; changing it selects different data volumes.");
  else if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(effective.COMPOSE_PROJECT_NAME)) errors.push("Invalid COMPOSE_PROJECT_NAME.");
  if (!/^[a-z0-9][a-z0-9._:/-]{0,240}$/.test(effective.GAME_IMAGE)) errors.push("GAME_IMAGE must be a lowercase Docker image/tag, without interpolation or a digest when building.");
  if (effective.GAME_IMAGE.endsWith(":local") || effective.GAME_IMAGE.endsWith(":latest") || !effective.GAME_IMAGE.slice(effective.GAME_IMAGE.lastIndexOf("/") + 1).includes(":")) warnings.push("Use a unique tested image tag for production upgrades and keep the previous image.");
  if (gateway === "standalone" && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(effective.TLS_EMAIL ?? "") || /@example\.(?:com|org|net)$/.test(effective.TLS_EMAIL))) errors.push("Standalone Caddy requires a real TLS_EMAIL.");
  if (!/^\/app\/data\/[A-Za-z0-9_-]+\.sqlite$/.test(values.ROOM_STORE_PATH ?? "")) errors.push("Container ROOM_STORE_PATH must be a .sqlite file directly under the persistent /app/data directory.");
  const subnet = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(effective.GAME_NETWORK_SUBNET);
  if (!subnet || isIP(subnet[1]) !== 4 || Number(subnet[2]) < 16 || Number(subnet[2]) > 29) errors.push("GAME_NETWORK_SUBNET must be a private IPv4 CIDR with prefix /16 through /29.");
  else {
    const start = ipv4Number(subnet[1]), size = 2 ** (32 - Number(subnet[2]));
    if (start % size || !privateIPv4(start) || !privateIPv4(start + size - 1)) errors.push("Docker subnet must be aligned and entirely within RFC1918 private IPv4 space.");
    const addresses = [effective.GAME_NETWORK_GATEWAY, effective.GAME_CADDY_IP, effective.GAME_APP_IP];
    if (new Set(addresses).size !== 3) errors.push("Gateway, Caddy and app addresses must be distinct.");
    for (const [index, value] of addresses.entries()) if (isIP(value) !== 4 || ipv4Number(value) <= start || ipv4Number(value) >= start + size - 1) errors.push(`Docker address ${index + 1} must be a usable IPv4 host within the configured subnet.`);
  }
  if (values.LIVEKIT_API_URL) {
    try { const api = new URL(values.LIVEKIT_API_URL); if (api.pathname !== "/" || api.search || api.hash || api.username || api.password) throw new Error(); }
    catch { errors.push("LIVEKIT_API_URL must be an HTTP(S) origin without path, query or credentials."); }
  }
  try { readConfig({ ...values, APP_MODE: "public", HOST: "0.0.0.0", PORT: "3000", TRUST_PROXY_CIDRS: `${effective.GAME_NETWORK_GATEWAY}/32,${effective.GAME_CADDY_IP}/32` }); }
  catch { errors.push("Server configuration rejected: verify entrance code, HTTPS origin, VOICE_REQUIRED and complete WSS/LiveKit credentials."); }
  if (values.LIVEKIT_API_URL?.startsWith("http:")) warnings.push("LiveKit management credentials use HTTP; keep this API on a trusted private network or use HTTPS.");
  warnings.push("Offline configuration check only: verify DNS, free ports, Docker/VPN subnet conflicts, firewall, certificates and real media connectivity on the target server.");
  return { errors, warnings, settings: { domain: effective.GAME_DOMAIN, port: Number(effective.GAME_HTTP_PORT), project: effective.COMPOSE_PROJECT_NAME,
    image: effective.GAME_IMAGE, subnet: effective.GAME_NETWORK_SUBNET, networkGateway: effective.GAME_NETWORK_GATEWAY, caddyIP: effective.GAME_CADDY_IP, appIP: effective.GAME_APP_IP, voiceEnabled: Boolean(values.LIVEKIT_URL) } };
}

export function createDeploymentFile(file, { domain, email = "", port = "3100", project = "avalon" }) {
  const target = path.resolve(file);
  if (!/^\.env\.public(?:\.[a-z0-9_-]+)?$/.test(path.basename(target)) || path.basename(target).endsWith(".example") || target.split(path.sep).some(part => ["public", "dist", ".git", "node_modules"].includes(part.toLowerCase()))) throw new Error("Use a private .env.public[.name] file, not an example file or a path in public assets, build output or Git metadata.");
  const envPath = path.relative(path.join(root, "deploy"), target).replaceAll("\\", "/");
  const text = ["# Private deployment settings. Do not commit or share this file.", "# Keep this project name unchanged after first deployment.",
    `COMPOSE_PROJECT_NAME=${project}`, `GAME_DOMAIN=${domain}`, `PUBLIC_ORIGIN=https://${domain}`, `TLS_EMAIL=${email}`,
    ...Object.entries({ ...deploymentDefaults, GAME_ENV_FILE: envPath, GAME_HTTP_PORT: String(port) }).map(([key, value]) => `${key}=${value}`),
    `GAME_ACCESS_CODE=${randomBytes(32).toString("base64url")}`, "ROOM_STORE_PATH=/app/data/rooms.sqlite", "VOICE_REQUIRED=false", ""].join("\n");
  const result = inspectDeployment(parseDeploymentEnv(text));
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Exclusive creation leaves existing secrets and deployment identity untouched.
  writeFileSync(target, text, { flag: "wx", mode: 0o600 });
}

export function readDeploymentFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error("Use a regular deployment file of at most 32 KiB; symlinks are not supported.");
  if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Private deployment file must not be accessible to group/others; run chmod 600 on that file.");
  return parseDeploymentEnv(readFileSync(file, "utf8"));
}

export function renderCaddy(settings, gateway = "host") {
  if (!["host", "container"].includes(gateway)) throw new Error("Caddy fragment generation is for an existing host/container gateway only.");
  if (!validDomain(settings.domain) || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || isIP(settings.appIP) !== 4) throw new Error("Refusing to render invalid Caddy settings.");
  const upstream = gateway === "host" ? `127.0.0.1:${settings.port}` : `${settings.appIP}:3000`;
  return `# Generated site only; import into the existing Caddyfile, then validate/reload.\nimport caddy-policy.caddy\n\n${settings.domain} {\n\timport avalon_game ${upstream}\n}\n`;
}

export function writeCaddyDirectory(directory, settings, gateway = "host") {
  const fragment = renderCaddy(settings, gateway);
  const target = path.resolve(directory);
  if (existsSync(target)) throw new Error("Caddy output directory already exists; use a new directory, not --force.");
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(path.join(target, "Caddyfile.existing"), fragment, { flag: "wx", mode: 0o644 });
  writeFileSync(path.join(target, "caddy-policy.caddy"), readFileSync(path.join(root, "deploy/caddy-policy.caddy")), { flag: "wx", mode: 0o644 });
}

function main(args) {
  const command = args.shift();
  const options = {};
  const allowed = command === "init" ? ["env-file", "domain", "email", "port", "project"] : command === "caddy" ? ["env-file", "gateway", "output-dir"] : command === "check" ? ["env-file", "gateway"] : [];
  if (!allowed.length) throw new Error("Usage: deployment.mjs init|check|caddy [--env-file path] [command options].");
  while (args.length) {
    const flag = args.shift();
    if (!flag?.startsWith("--") || !allowed.includes(flag.slice(2)) || Object.hasOwn(options, flag.slice(2)) || !args.length || args[0].startsWith("--")) throw new Error("Unknown, duplicate or incomplete deployment option.");
    options[flag.slice(2)] = args.shift();
  }
  const file = path.resolve(options["env-file"] ?? path.join(root, "deploy/.env.public"));
  if (command === "init") {
    createDeploymentFile(file, options);
    console.log("OK: private settings created with a random entrance code; existing files are never overwritten. Read the code locally, do not share the file.");
    if (process.platform === "win32") console.warn("WARN: restrict the file ACL on Windows; POSIX deployments use mode 0600.");
    return;
  }
  const result = inspectDeployment(readDeploymentFile(file), { gateway: options.gateway ?? "host", hostEnv: process.env, envFile: file });
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  if (result.errors.length) { process.exitCode = 1; return; }
  if (command === "caddy") {
    writeCaddyDirectory(options["output-dir"] ?? path.join(root, ".media/deploy-caddy"), result.settings, options.gateway ?? "host");
    console.log("OK: generated Caddy site and shared policy. No credentials included; nothing installed or reloaded.");
  } else console.log("OK: deployment settings passed offline validation. No services started, contacted or modified.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    console.error(code ? "Deployment file operation failed (missing file, permissions or existing output); no existing file was overwritten." : error instanceof Error ? error.message : "Deployment check failed.");
    process.exitCode = 1;
  }
}
