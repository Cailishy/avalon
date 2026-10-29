import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { ConnectionQuota, TokenBucket, protectGameEvents, requestPolicy, validateEvent } from "./security";
import type { Socket } from "socket.io";
import { readConfig } from "./config";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

const voice = { LIVEKIT_URL: "wss://voice.example.com", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "s".repeat(40) };
const publicEnv = { APP_MODE: "public", PUBLIC_ORIGIN: "https://game.example.com", GAME_ACCESS_CODE: "private-random-code-123", ...voice };
const auth = { roomCode: "ABCDE", playerId: `p_${"a".repeat(24)}`, sessionToken: `s_${"b".repeat(24)}` };
function request(remoteAddress: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress }, connection: { remoteAddress } } as unknown as IncomingMessage;
}

describe("Public configuration", () => {
  it("keeps LAN defaults but makes public startup opt-in and fail-closed", () => {
    expect(readConfig({ GAME_ACCESS_CODE: "test-lan-code" })).toMatchObject({ publicMode: false, host: "0.0.0.0", port: 3000 });
    expect(readConfig(publicEnv)).toMatchObject({ publicMode: true, host: "127.0.0.1", origin: publicEnv.PUBLIC_ORIGIN });
  });
  it.each([
    { GAME_ACCESS_CODE: "short-test-code" }, { PUBLIC_ORIGIN: "http://game.example.com" }, { GAME_ACCESS_CODE: "a".repeat(20) },
    { PUBLIC_ORIGIN: "https://game.example.com/path" }, { LIVEKIT_URL: "ws://voice.example.com" },
    { LIVEKIT_API_SECRET: "short" }, { TRUST_PROXY_CIDRS: "true" }, { TRUST_PROXY_CIDRS: "0.0.0.0/0" },
    { GAME_ACCESS_CODE: "replace-with-a-private-passcode" }, { APP_MODE: "other" }, { PORT: "65536" },
  ])("rejects unsafe configuration %j", changes => { expect(() => readConfig({ ...publicEnv, ...changes })).toThrow(); });
  it("rejects development/public mode and incomplete media credentials", () => {
    expect(() => readConfig(publicEnv, true)).toThrow();
    expect(() => readConfig({ ...publicEnv, LIVEKIT_API_KEY: "" })).toThrow();
    expect(readConfig({ ...publicEnv, LIVEKIT_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" }).voice).toBeUndefined();
  });
  it("runs the public base game without LiveKit but supports an explicit voice requirement", () => {
    const base = { APP_MODE: "public", PUBLIC_ORIGIN: "https://game.example.com", GAME_ACCESS_CODE: "private-random-code-123" };
    expect(readConfig(base)).toMatchObject({ publicMode: true, voiceRequired: false });
    expect(() => readConfig({ ...base, VOICE_REQUIRED: "true" })).toThrow("Configure LiveKit");
    expect(readConfig({ ...publicEnv, VOICE_REQUIRED: "true" }).voiceRequired).toBe(true);
    expect(() => readConfig({ ...base, VOICE_REQUIRED: "yes" })).toThrow("VOICE_REQUIRED");
  });
  it.each(["public/rooms.sqlite", "dist/rooms.sqlite", "dist"])("rejects public persistence paths: %s", path => {
    expect(() => readConfig({ ...publicEnv, ROOM_STORE_PATH: path })).toThrow("outside public assets");
  });
  it("does not trust proxy headers in LAN mode", () => {
    const policy = requestPolicy(readConfig({ GAME_ACCESS_CODE: "test-lan-code" }));
    const req = request("203.0.113.8", { host: "localhost:3100", "x-forwarded-for": "198.51.100.5", "x-forwarded-proto": "https" });
    expect(policy.address(req)).toBe("203.0.113.8");
    expect(policy.secure(req)).toBe(false);
  });
  it("only accepts the configured HTTPS host and explicitly trusted forwarding hop", () => {
    const policy = requestPolicy(readConfig(publicEnv));
    const headers = { host: "game.example.com", origin: "https://game.example.com", "x-forwarded-for": "198.51.100.5", "x-forwarded-proto": "https" };
    expect(policy.originAllowed(request("127.0.0.1", headers))).toBe(true);
    expect(policy.address(request("127.0.0.1", headers))).toBe("198.51.100.5");
    expect(policy.originAllowed(request("203.0.113.1", headers))).toBe(false);
    expect(policy.originAllowed(request("127.0.0.1", { ...headers, host: "evil.example.com" }))).toBe(false);
    expect(policy.originAllowed(request("127.0.0.1", { ...headers, origin: "https://evil.example.com" }))).toBe(false);
  });
});

describe("Bounded resource guards", () => {
  it("enforces traffic budgets and refills without growing the key map indefinitely", () => {
    let time = 0;
    const bucket = new TokenBucket(2, 1, 2, () => time);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(true);
    expect(bucket.take("a")).toBe(false);
    expect(bucket.take("b")).toBe(true);
    expect(bucket.take("c")).toBe(false);
    time += 2000;
    expect(bucket.take("c")).toBe(true);
    expect(bucket.take("a")).toBe(true);
  });
  it("enforces per-address/global connection caps and releases idempotently", () => {
    const quota = new ConnectionQuota(2, 3);
    const a = quota.acquire("a")!;
    const b = quota.acquire("a")!;
    expect(quota.acquire("a")).toBeNull();
    const c = quota.acquire("b")!;
    expect(quota.acquire("c")).toBeNull();
    a(); a();
    expect(quota.acquire("c")).toBeTypeOf("function");
    expect(quota.acquire("d")).toBeNull();
    b(); c();
  });
});

describe("Single-Caddy application HTTP guards", () => {
  const headers = { host: "game.example.com", "x-forwarded-proto": "https" };
  function guarded(policy: ReturnType<typeof requestPolicy>, url = "/", options: { ip?: string; method?: string; headers?: Record<string, string>; hold?: boolean } = {}) {
    const req = Object.assign(request("127.0.0.1", { ...headers, "x-forwarded-for": options.ip ?? "198.51.100.5", ...options.headers }), { url, method: options.method ?? "GET" });
    let status = 200;
    let accepted = false;
    let responseHeaders: Record<string, unknown> = {};
    const response = Object.assign(new EventEmitter(), {
      writeHead: (code: number, value: Record<string, unknown>) => { status = code; responseHeaders = value; },
      end: () => { if (!options.hold) response.emit("finish"); },
    });
    policy.guard(req, response as unknown as ServerResponse, () => { accepted = true; if (!options.hold) response.emit("finish"); });
    return { status, accepted, responseHeaders, response };
  }
  it("rejects unsupported methods, private/encoded paths and oversized declared bodies", () => {
    const policy = requestPolicy(readConfig(publicEnv));
    expect(guarded(policy).accepted).toBe(true);
    expect(guarded(policy, "/", { method: "PUT" }).status).toBe(405);
    for (const url of ["/.env", "/%2eenv", "/assets/.secret", "/assets/a.ZIP", "/src/index.ts", "/data/rooms.sqlite", "/api/unknown"]) expect(guarded(policy, url).status).toBe(404);
    expect(guarded(policy, "/%ZZ").status).toBe(400);
    expect(guarded(policy, "/api/access", { headers: { "content-length": "1025" } }).status).toBe(413);
    expect(guarded(policy, "/socket.io/", { headers: { "content-length": "16385" } }).status).toBe(413);
  });
  it("shares ordinary HTTP budgets per client IP and across all clients, then refills", () => {
    let now = 0;
    const policy = requestPolicy(readConfig(publicEnv), () => now);
    for (let i = 0; i < 120; i++) expect(guarded(policy).accepted).toBe(true);
    expect(guarded(policy).status).toBe(429);
    now = 1000;
    for (let i = 0; i < 30; i++) expect(guarded(policy).accepted).toBe(true);
    expect(guarded(policy).status).toBe(429);
    const global = requestPolicy(readConfig(publicEnv), () => 0);
    for (let i = 0; i < 600; i++) expect(guarded(global, "/", { ip: `198.51.100.${Math.floor(i / 100)}` }).accepted).toBe(true);
    expect(guarded(global, "/", { ip: "203.0.113.10" }).status).toBe(429);
  });
  it("limits all login attempts separately from Engine.IO HTTP traffic", () => {
    let now = 0;
    const policy = requestPolicy(readConfig(publicEnv), () => now);
    for (let i = 0; i < 20; i++) expect(guarded(policy, "/api/access", { method: "POST" }).accepted).toBe(true);
    expect(guarded(policy, "/api/access", { method: "POST" })).toMatchObject({ status: 429, responseHeaders: { "Retry-After": "5" } });
    expect(guarded(policy).accepted).toBe(true);
    for (let i = 0; i < 40; i++) expect(guarded(policy, "/socket.io/?transport=polling").accepted).toBe(true);
    expect(guarded(policy, "/socket.io/?transport=polling").status).toBe(429);
    now = 12001;
    expect(guarded(policy, "/api/access", { method: "POST" }).accepted).toBe(true);
    expect(guarded(policy, "/socket.io/?transport=websocket", { headers: { upgrade: "websocket" } }).accepted).toBe(true);
  });
  it("releases active request slots once on completion or abort", () => {
    const policy = requestPolicy(readConfig(publicEnv), () => 0);
    const pending = Array.from({ length: 64 }, () => guarded(policy, "/", { hold: true }));
    expect(pending.every(result => result.accepted)).toBe(true);
    expect(guarded(policy).status).toBe(429);
    pending[0].response.emit("finish");
    const replacement = guarded(policy, "/", { hold: true });
    expect(replacement.accepted).toBe(true);
    pending[0].response.emit("close");
    expect(guarded(policy).status).toBe(429);
    replacement.response.emit("close");
    expect(guarded(policy).accepted).toBe(true);
    pending.forEach(result => result.response.emit("close"));
  });
  it("enforces a process-wide active request cap even across many IPs", () => {
    let now = 0;
    const policy = requestPolicy(readConfig(publicEnv), () => now);
    const pending = Array.from({ length: 800 }, (_, i) => {
      if (i % 100 === 0) now += 1000;
      return guarded(policy, "/", { hold: true, ip: `198.51.100.${Math.floor(i / 60)}` });
    });
    expect(pending.every(result => result.accepted)).toBe(true);
    expect(guarded(policy, "/", { ip: "203.0.113.10" }).status).toBe(429);
    pending[0].response.emit("close");
    expect(guarded(policy, "/", { ip: "203.0.113.10" }).accepted).toBe(true);
    pending.forEach(result => result.response.emit("close"));
  });
  it("does not let an Upgrade header bypass quotas on ordinary HTTP responses", () => {
    const policy = requestPolicy(readConfig(publicEnv), () => 0);
    const pending = Array.from({ length: 64 }, () => guarded(policy, "/", { hold: true, headers: { upgrade: "websocket" } }));
    expect(pending.every(result => result.accepted)).toBe(true);
    expect(guarded(policy, "/", { headers: { upgrade: "websocket" } }).status).toBe(429);
    pending.forEach(result => result.response.emit("close"));
  });
  it("handles Engine.IO's upgrade response shim without attaching HTTP lifecycle listeners", () => {
    const policy = requestPolicy(readConfig(publicEnv));
    const req = Object.assign(request("127.0.0.1", { ...headers, upgrade: "websocket" }), { url: "/socket.io/?transport=websocket", method: "GET" });
    const response = { writeHead: () => {}, end: () => {} };
    let accepted = false;
    expect(() => policy.guard(req, response as unknown as ServerResponse, () => { accepted = true; })).not.toThrow();
    expect(accepted).toBe(true);
  });
});

describe("Network payload schemas", () => {
  const meta = { requestId: `r_${"a".repeat(32)}`, issuedAt: Date.now() };
  const staged = { ...meta, phaseId: `phase_${"b".repeat(32)}` };
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])("rejects inherited event name %s without throwing", event => {
    expect(validateEvent(event, {})).toBeNull();
  });
  it("accepts real boolean choices but never coerces strings or objects", () => {
    expect(validateEvent("vote:submit", { ...auth, ...staged, approved: false })).toEqual({ ...auth, ...staged, approved: false });
    for (const value of ["false", 0, null, {}, []]) expect(validateEvent("vote:submit", { ...auth, ...staged, approved: value })).toBeNull();
    expect(validateEvent("mission:submit", { ...auth, ...staged, failed: "false" })).toBeNull();
    expect(validateEvent("player:setReady", { ...auth, ...staged, ready: "true" })).toBeNull();
  });
  it("rejects unknown fields, malformed identities and huge arrays", () => {
    expect(validateEvent("room:start", { ...auth, ...staged, admin: true })).toBeNull();
    expect(validateEvent("room:start", { ...auth, ...staged, sessionToken: "fake" })).toBeNull();
    expect(validateEvent("team:propose", { ...auth, ...staged, team: Array(100).fill(auth.playerId) })).toBeNull();
    expect(validateEvent("not-an-event", {})).toBeNull();
  });
  it("normalizes invitations but limits names and control characters", () => {
    expect(validateEvent("room:join", { ...meta, name: " Alice ", roomCode: " abcde " })).toEqual({ ...meta, name: "Alice", roomCode: "ABCDE" });
    expect(validateEvent("room:create", { ...meta, name: "a".repeat(17) })).toBeNull();
    expect(validateEvent("room:create", { ...meta, name: "a\u0000b" })).toBeNull();
    expect(validateEvent("room:create", { ...meta, name: "玩家", targetPlayerCount: "5" })).toBeNull();
  });
});

describe("Shared message budgets", () => {
  it("disconnects sustained traffic-limit abuse but tolerates a small burst", () => {
    let handler!: (packet: unknown[], next: () => void) => void;
    let disconnected = 0;
    const socket = { data: {}, use: (value: typeof handler) => { handler = value; }, disconnect: () => { disconnected++; } } as unknown as Socket;
    const shared = { global: new TokenBucket(1, 1, 1, () => 0), addresses: new TokenBucket(120, 40) };
    protectGameEvents(socket, "a", new TokenBucket(30, 1), shared);
    handler(["room:create", { name: "Player" }, () => {}], () => {});
    for (let i = 0; i < 19; i++) handler(["room:create", { name: "Player" }, () => {}], () => {});
    expect(disconnected).toBe(0);
    handler(["room:create", { name: "Player" }, () => {}], () => {});
    expect(disconnected).toBe(1);
  });
  it("shares source and global quotas across different sockets", () => {
    const shared = { global: new TokenBucket(3, 1, 1, () => 0), addresses: new TokenBucket(1, 1, 8, () => 0) };
    const attempts = new TokenBucket(10, 1);
    function connect(address: string) {
      let packetHandler!: (packet: unknown[], next: () => void) => void;
      const socket = { data: {}, use: (handler: typeof packetHandler) => { packetHandler = handler; } } as unknown as Socket;
      protectGameEvents(socket, address, attempts, shared);
      return () => {
        let result: unknown = "accepted";
        packetHandler(["room:create", { name: "Player", requestId: `r_${"a".repeat(32)}`, issuedAt: Date.now() }, (value: unknown) => { result = value; }], () => {});
        return result;
      };
    }
    expect(connect("a")()).toBe("accepted");
    expect(connect("a")()).toMatchObject({ ok: false });
    expect(connect("b")()).toBe("accepted");
    expect(connect("c")()).toMatchObject({ ok: false });
  });
});
