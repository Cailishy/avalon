import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { readConfig } from "../../src/server/config.ts";
import { requestPolicy } from "../../src/server/security.ts";
import { writeCaddyDirectory } from "../deploy/deployment.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.env.CADDY_BIN ?? "caddy";
const temporaryRoot = path.resolve(os.tmpdir());
const temporary = await mkdtemp(path.join(temporaryRoot, "avalon-caddy-"));
const clients = [];
let caddy;
let stopped;
let gatewayPort;
let upstream;
let sockets;
let forwardedRequests = 0;
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const freePort = async () => {
  const probe = http.createServer(); const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve)); return port;
};
const request = (url = "/", options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port: gatewayPort, path: url, ...options, headers: {
    Host: `127.0.0.1:${gatewayPort}`, "X-Forwarded-For": "198.51.100.12", "X-Real-IP": "198.51.100.12",
    "X-Forwarded-Proto": "http", Forwarded: "for=127.0.0.1;proto=http", ...options.headers,
  } }, res => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    res.on("error", reject);
  });
  req.setTimeout(5000, () => req.destroy(new Error("Caddy verification request timed out.")));
  req.on("error", reject);
  req.end(options.body);
});

try {
  const environment = { ...process.env, GAME_DOMAIN: "game.example.test", TLS_EMAIL: "admin@example.test", XDG_DATA_HOME: temporary, XDG_CONFIG_HOME: temporary };
  for (const name of ["Caddyfile", "Caddyfile.existing"]) {
    const validated = spawnSync(binary, ["validate", "--config", path.join(root, "deploy", name), "--adapter", "caddyfile"], { env: environment, encoding: "utf8", windowsHide: true });
    assert.equal(validated.status, 0, validated.stderr || String(validated.error));
  }
  for (const gateway of ["host", "container"]) {
    const directory = path.join(temporary, `generated-${gateway}`);
    writeCaddyDirectory(directory, { domain: "game.gateway-fixture.org", port: 3100, appIP: "172.30.70.3" }, gateway);
    const validated = spawnSync(binary, ["validate", "--config", path.join(directory, "Caddyfile.existing"), "--adapter", "caddyfile"], { env: environment, encoding: "utf8", windowsHide: true });
    assert.equal(validated.status, 0, validated.stderr || String(validated.error));
  }
  gatewayPort = await freePort();
  const origin = `https://127.0.0.1:${gatewayPort}`;
  const policy = requestPolicy(readConfig({ APP_MODE: "public", PUBLIC_ORIGIN: origin, GAME_ACCESS_CODE: "synthetic-verification-passcode", TRUST_PROXY_CIDRS: "127.0.0.1/32" }));
  upstream = http.createServer((req, res) => {
    forwardedRequests++;
    policy.guard(req, res, () => {
      req.on("error", () => res.destroy());
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ host: req.headers.host, address: policy.address(req), protocol: req.headers["x-forwarded-proto"], forwarded: req.headers.forwarded ?? null }));
      });
      req.resume();
    });
  });
  sockets = new Server(upstream);
  sockets.engine.use(policy.guard);
  sockets.on("connection", socket => socket.on("test:echo", ack => ack("ok")));
  const appPort = await listen(upstream);
  const config = (await readFile(path.join(root, "deploy/Caddyfile"), "utf8"))
    .replace("{", "{\n\tdefault_bind 127.0.0.1")
    .replace("import avalon_game app:3000", `import avalon_game 127.0.0.1:${appPort}`)
    + `\nhttp://other.example.test:${gatewayPort} {\n\trespond "other-site"\n}\n`;
  await writeFile(path.join(temporary, "Caddyfile"), config);
  const logFile = path.join(temporary, "requests.log").replaceAll("\\", "/");
  const rules = (await readFile(path.join(root, "deploy/caddy-policy.caddy"), "utf8")).replace("output stdout", `output file "${logFile}"`);
  await writeFile(path.join(temporary, "caddy-policy.caddy"), rules);
  let diagnostics = "";
  caddy = spawn(binary, ["run", "--config", path.join(temporary, "Caddyfile"), "--adapter", "caddyfile"], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...environment, GAME_DOMAIN: `http://127.0.0.1:${gatewayPort}`, XDG_DATA_HOME: temporary, XDG_CONFIG_HOME: temporary },
  });
  stopped = new Promise(resolve => caddy.once("exit", resolve));
  caddy.stderr.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-4000); });
  caddy.once("error", error => { diagnostics = error.message; });
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try { if ((await request()).status === 200) { ready = true; break; } } catch {}
    if (caddy.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, `Caddy did not become ready: ${diagnostics}`);
  const normal = await request();
  assert.deepEqual(JSON.parse(normal.body), { host: `127.0.0.1:${gatewayPort}`, address: "127.0.0.1", protocol: "https", forwarded: null });
  assert.equal((await request("/", { headers: { Host: `other.example.test:${gatewayPort}` } })).body, "other-site");
  const beforeUnknownHost = forwardedRequests;
  await request("/", { headers: { Host: "unconfigured.example.test" } });
  assert.equal(forwardedRequests, beforeUnknownHost, "An unrelated host reached the game upstream.");
  assert.equal((await request("/", { port: appPort, localAddress: "127.0.0.2", headers: { "X-Forwarded-Proto": "https" } })).status, 403);
  assert.equal((await request("/", { method: "PUT" })).status, 405);
  for (const url of ["/.env", "/.git/config", "/%2eenv", "/src/server/index.ts", "/data/rooms.sqlite", "/assets/a.js.map", "/assets/a.zip", "/unregistered-route", "/api/not-real"]) {
    assert.equal((await request(url)).status, 404, url);
  }
  assert.equal((await request("/api/access", { method: "POST", body: "x".repeat(1025) })).status, 413);
  assert.equal((await request("/socket.io/?EIO=4&transport=polling", { method: "POST", body: "x".repeat(17000) })).status, 413);
  assert.equal((await request("/api/access", { method: "POST", headers: { "Transfer-Encoding": "chunked" }, body: "x".repeat(1025) })).status, 413);
  for (const transport of ["websocket", "polling"]) {
    const socket = io(`http://127.0.0.1:${gatewayPort}`, { transports: [transport], reconnection: false, timeout: 5000, extraHeaders: { Origin: origin, "X-Forwarded-For": "203.0.113.99" } });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    assert.equal(await socket.timeout(5000).emitWithAck("test:echo"), "ok");
    socket.disconnect();
  }
  await request("/?private_probe=never-log-this", { headers: { Cookie: "synthetic-private-cookie", Authorization: "Bearer synthetic-private-header" } });
  const logins = await Promise.all(Array.from({ length: 25 }, () => request("/api/access", { method: "POST", body: "{}" })));
  const rejected = logins.find(response => response.status === 429);
  assert(rejected, "Application login request budget did not apply through Caddy.");
  assert.equal(rejected.headers["retry-after"], "5");
  const logs = await readFile(path.join(temporary, "requests.log"), "utf8");
  for (const secret of ["never-log-this", "synthetic-private-cookie", "synthetic-private-header"]) assert(!logs.includes(secret));
  const entries = logs.trim().split("\n").map(line => JSON.parse(line));
  assert(entries.some(entry => entry.status === 200));
  assert(entries.every(entry => !entry.request?.uri && !entry.request?.headers && !entry.resp_headers));
  console.log("PASS: standard/generated Caddy syntax, shared-host routing, trusted headers, method/path/body guards (including chunked), WebSocket/polling, application login limits and private access logs.");
  console.log("HTTP loopback substitutes TLS termination only in this isolated test; no certificates or existing rooms were used.");
} finally {
  clients.forEach(client => client.disconnect());
  if (caddy?.pid && caddy.exitCode === null) { caddy.kill(); await stopped; }
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  else if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
  // eslint-disable-next-line no-unsafe-finally -- Never recursively remove an unverified directory.
  if (path.dirname(temporary) !== temporaryRoot || !path.basename(temporary).startsWith("avalon-caddy-")) throw new Error("Unsafe gateway cleanup path.");
  await rm(temporary, { recursive: true, force: true });
}
