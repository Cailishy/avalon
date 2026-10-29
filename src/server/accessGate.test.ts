import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessGate } from "./accessGate";
import { attachSocketHandlers, type SocketRuntime } from "./socketHandlers";

let server: http.Server;
let io: Server;
let runtime: SocketRuntime;
let origin: string;
let clock: number;
let gate: ReturnType<typeof createAccessGate>;
let clients: Socket[];

beforeEach(async () => {
  clock = Date.now();
  clients = [];
  gate = createAccessGate("test-secret", () => clock);
  const app = express();
  app.use("/api/access", gate.router);
  app.use(gate.protectPages(async () => '<form id="access-form">Entrance</form>'));
  app.get(["/", "/index.html", "/room/invite"], (_req, res) => res.send("GAME HOME"));
  app.get("/assets/test.js", (_req, res) => res.type("js").send("public bundle"));
  app.get("*", gate.protectPages(async () => '<form id="access-form">Entrance</form>', true), (_req, res) => res.send("GAME HOME"));
  server = http.createServer(app);
  io = new Server(server);
  gate.protectSockets(io);
  runtime = attachSocketHandlers(io, []);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  clients.forEach(client => client.disconnect());
  runtime.close();
  await new Promise<void>(resolve => io.close(() => resolve()));
});

function submit(code: unknown = "test-secret", headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/access`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ code }),
  });
}

async function unlock(): Promise<string> {
  const response = await submit();
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

function socket(cookie?: string, transport = "websocket", extra: Record<string, string> = {}): Socket {
  const client = createClient(origin, {
    transports: [transport], reconnection: false, forceNew: true, autoConnect: false,
    extraHeaders: { ...(cookie ? { Cookie: cookie } : {}), ...extra },
  });
  clients.push(client);
  return client;
}

function connect(client: Socket) {
  return new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
    client.connect();
  });
}

describe("Server entrance verification", () => {
  it.each(["", " ", "a".repeat(129)])("fails closed with invalid server configuration: %s", code => {
    expect(() => createAccessGate(code)).toThrow("GAME_ACCESS_CODE");
  });

  it.each(["/", "/index.html", "/?room=ABCDE", "/room/invite", "/missing.js", "/assets/missing.css", "/@missing.js"])("serves only the entrance document for anonymous %s", async url => {
    const response = await fetch(origin + url);
    expect(await response.text()).toContain('id="access-form"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });

  it("issues an HttpOnly same-site cookie and unlocks the actual home", async () => {
    const response = await submit();
    expect(await response.json()).toEqual({ ok: true });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=43200");
    expect(setCookie).not.toContain("test-secret");
    const home = await fetch(`${origin}/?room=ABCDE`, { headers: { Cookie: setCookie.split(";")[0] } });
    expect(await home.text()).toBe("GAME HOME");
    expect(home.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["wrong", 12345, null, {}, "a".repeat(129)])("rejects incorrect or non-string codes: %j", async code => {
    const response = await submit(code);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await response.json()).ok).toBe(false);
  });

  it("limits five failed attempts per address and allows retry after a minute", async () => {
    for (let i = 0; i < 5; i++) expect((await submit("wrong")).status).toBe(401);
    const denied = await submit();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    clock += 60_000;
    expect((await submit()).status).toBe(200);
  });

  it("clears earlier failures after a successful verification", async () => {
    for (let i = 0; i < 4; i++) await submit("wrong");
    await unlock();
    for (let i = 0; i < 5; i++) expect((await submit("wrong")).status).toBe(401);
  });

  it("rejects cross-origin submissions and permits same-origin requests", async () => {
    expect((await submit("test-secret", { Origin: "https://other.example" })).status).toBe(403);
    expect((await submit("test-secret", { Origin: "null" })).status).toBe(403);
    expect((await submit("test-secret", { Origin: origin })).status).toBe(200);
  });

  it("returns controlled errors for malformed and oversized JSON", async () => {
    for (const body of ["{", JSON.stringify({ code: "a".repeat(2048) })]) {
      const response = await fetch(`${origin}/api/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      expect(response.status).toBe(400);
      expect((await response.json()).ok).toBe(false);
    }
  });

  it("keeps static bundles public without granting access to unknown APIs", async () => {
    expect(await (await fetch(`${origin}/assets/test.js`)).text()).toBe("public bundle");
    expect((await fetch(`${origin}/api/not-real`)).status).toBe(404);
    expect((await fetch(`${origin}/api/access`)).status).toBe(405);
    expect((await fetch(origin, { method: "POST" })).status).toBe(401);
  });

  it("rejects forged, malformed, duplicate, expired and previous-process cookies", async () => {
    const cookie = await unlock();
    const candidates = [cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A"), "awalong-access=malformed-cookie", `${cookie}; ${cookie}`];
    for (const candidate of candidates) {
      expect(await (await fetch(origin, { headers: { Cookie: candidate } })).text()).toContain("Entrance");
    }
    expect(createAccessGate("test-secret").hasAccess({ headers: { cookie } } as http.IncomingMessage)).toBe(false);
    clock += 12 * 60 * 60 * 1000;
    expect(await (await fetch(origin, { headers: { Cookie: cookie } })).text()).toContain("Entrance");
  });

  it.each(["websocket", "polling"])("blocks direct %s game connections without a valid entrance cookie", async transport => {
    const client = socket(undefined, transport);
    await expect(connect(client)).rejects.toMatchObject({ data: { code: "ACCESS_REQUIRED" } });
    expect(io.sockets.sockets.size).toBe(0);
  });

  it.each(["websocket", "polling"])("allows verified %s clients to create real server rooms", async transport => {
    const client = socket(await unlock(), transport);
    await connect(client);
    const result = await client.timeout(1000).emitWithAck("room:create", { name: "Verified", targetPlayerCount: 5, requestId: `r_${"a".repeat(32)}`, issuedAt: Date.now() });
    expect(result.ok).toBe(true);
    expect(runtime.rooms.getPublicState(result.roomCode).players[0].name).toBe("Verified");
  });

  it("blocks a socket with a valid cookie but a foreign origin", async () => {
    await expect(connect(socket(await unlock(), "websocket", { Origin: "https://other.example" })))
      .rejects.toMatchObject({ data: { code: "ACCESS_REQUIRED" } });
  });

  it("rejects expired reconnects and stops commands on an already-open connection", async () => {
    const cookie = await unlock();
    const client = socket(cookie);
    await connect(client);
    let stateLeaked = false;
    client.on("room:state", () => { stateLeaked = true; });
    const expired = new Promise<void>(resolve => client.once("access:required", resolve));
    const disconnected = new Promise<void>(resolve => client.once("disconnect", () => resolve()));
    clock += 12 * 60 * 60 * 1000;
    client.emit("room:create", { name: "Expired" });
    await expired;
    await disconnected;
    expect(stateLeaked).toBe(false);
    await expect(connect(socket(cookie))).rejects.toMatchObject({ data: { code: "ACCESS_REQUIRED" } });
  });
});
