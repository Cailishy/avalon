import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestHandler } from "express";
import proxyaddr from "proxy-addr";
import { z } from "zod";
import type { Socket } from "socket.io";
import type { ServerConfig } from "./config";
import { COMMAND_EVENTS, isCommand, needsPhase } from "../shared/protocol";

export class TokenBucket {
  private entries = new Map<string, { tokens: number; time: number }>();
  constructor(private capacity: number, private refillPerSecond: number, private maxKeys = 4096, private now = Date.now) {}
  take(key: string): boolean {
    const time = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) {
        for (const [id, value] of this.entries) if (time - value.time >= this.capacity / this.refillPerSecond * 1000) this.entries.delete(id);
        if (this.entries.size >= this.maxKeys) return false;
      }
      entry = { tokens: this.capacity, time };
      this.entries.set(key, entry);
    }
    entry.tokens = Math.min(this.capacity, entry.tokens + Math.max(0, time - entry.time) / 1000 * this.refillPerSecond);
    entry.time = time;
    if (entry.tokens < 1) return false;
    entry.tokens--;
    return true;
  }
}

export class ConnectionQuota {
  private counts = new Map<string, number>();
  private total = 0;
  constructor(private perAddress = 20, private maximum = 500) {}
  acquire(address: string): (() => void) | null {
    const count = this.counts.get(address) ?? 0;
    if (count >= this.perAddress || this.total >= this.maximum) return null;
    this.counts.set(address, count + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.counts.get(address) ?? 1) - 1;
      if (remaining) this.counts.set(address, remaining);
      else this.counts.delete(address);
      this.total--;
    };
  }
}

export function requestPolicy(config: ServerConfig, now: () => number = Date.now) {
  const trust = proxyaddr.compile(config.trustProxy);
  const address = (req: IncomingMessage) => proxyaddr(req, config.publicMode ? trust : () => false);
  const secure = (req: IncomingMessage) => Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    (config.publicMode && trust(req.socket.remoteAddress ?? "", 0) && req.headers["x-forwarded-proto"] === "https");
  const originAllowed = (req: IncomingMessage) => {
    if (config.publicMode && (!secure(req) || req.headers.host !== new URL(config.origin!).host)) return false;
    if (!req.headers.origin) return true;
    return req.headers.origin === (config.origin ?? `${secure(req) ? "https" : "http"}://${req.headers.host}`);
  };
  const traffic = new TokenBucket(120, 30, 4096, now);
  const global = new TokenBucket(600, 300, 1, now);
  const login = new TokenBucket(20, 5 / 60, 4096, now);
  const engine = new TokenBucket(40, 10, 4096, now);
  const active = new ConnectionQuota(64, 800);
  // Engine.IO requests bypass Express, including polling and WebSocket upgrades.
  const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const reject = (status: number, error: string) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "5" } : {}) });
      res.end(JSON.stringify({ ok: false, error }));
    };
    if (!originAllowed(req)) { reject(403, "请求来源不被允许。"); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://internal").pathname); }
    catch { reject(400, "请求路径不正确。"); return; }
    const isLogin = /^\/api\/access\/?$/.test(pathname);
    const isEngine = pathname.startsWith("/socket.io/");
    if (config.publicMode) {
      if (!["GET", "HEAD", "POST"].includes(req.method ?? "GET")) { reject(405, "不支持的请求。"); return; }
      const page = ["/", "/index.html", "/access.html", "/manifest.webmanifest", "/favicon.ico", "/healthz"].includes(pathname);
      // eslint-disable-next-line no-control-regex -- Reject control bytes at the network boundary.
      if (/(^|\/)\./.test(pathname) || /[\\\u0000-\u001f\u007f]/.test(pathname) || /\.(?:map|zip|log|toml|ya?ml)$/i.test(pathname) || !(page || isLogin || isEngine || pathname.startsWith("/assets/"))) {
        reject(404, "资源不存在。"); return;
      }
      if (Number(req.headers["content-length"] ?? 0) > (isLogin ? 1024 : 16384)) { reject(413, "请求内容过大。"); return; }
    }
    const ip = address(req);
    if (!traffic.take(ip) || (config.publicMode && ((isLogin && !login.take(ip)) || (isEngine && !engine.take(ip)))) || !global.take("http")) {
      reject(429, "请求过于频繁。"); return;
    }
    if (config.publicMode && typeof res.once === "function") {
      const release = active.acquire(ip);
      if (!release) { reject(429, "并发请求过多。"); return; }
      res.once("finish", release);
      res.once("close", release);
    }
    next();
  };
  const middleware: RequestHandler = guard;
  return { address, secure, originAllowed, middleware, guard };
}

const roomCode = z.string().trim().toUpperCase().regex(/^[A-F0-9]{5,8}$/);
const playerId = z.string().regex(/^p_[a-f0-9]{24}$/);
const auth = { roomCode, playerId, sessionToken: z.string().regex(/^s_[a-f0-9]{24}$/) };
// eslint-disable-next-line no-control-regex -- Player names must not contain control bytes.
const name = z.string().trim().min(1).max(16).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const schemas: Record<string, z.ZodType> = {
  "room:create": z.strictObject({ name, targetPlayerCount: z.number().int().min(5).max(10).optional() }),
  "room:join": z.strictObject({ name, roomCode }),
  "room:addAI": z.strictObject({ ...auth, count: z.number().int().min(1).max(9) }),
  "room:setPlayerCount": z.strictObject({ ...auth, targetPlayerCount: z.number().int().min(5).max(10) }),
  "player:setReady": z.strictObject({ ...auth, ready: z.boolean() }),
  "player:kick": z.strictObject({ ...auth, targetId: playerId }),
  "team:propose": z.strictObject({ ...auth, team: z.array(playerId).min(1).max(10), questIndex: z.number().int().min(0).max(4).optional() }),
  "vote:submit": z.strictObject({ ...auth, approved: z.boolean() }),
  "mission:submit": z.strictObject({ ...auth, failed: z.boolean() }),
  "assassin:choose": z.strictObject({ ...auth, targetId: playerId }),
};
for (const event of ["room:rejoin", "room:sync", "room:start", "room:dissolve", "room:restart", "room:leave", "speech:end", "voice:join"]) schemas[event] = z.strictObject(auth);
schemas["clock:sync"] = z.strictObject({});
schemas["command:status"] = z.strictObject({
  requestId: z.string().regex(/^r_[a-f0-9]{32}$/), event: z.enum(COMMAND_EVENTS),
  sessionToken: z.string().regex(/^s_[a-f0-9]{24}$/).optional(),
});
for (const event of COMMAND_EVENTS) {
  schemas[event] = (schemas[event] as z.ZodObject).extend({
    requestId: z.string().regex(/^r_[a-f0-9]{32}$/),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ...(needsPhase(event) ? { phaseId: z.string().regex(/^phase_[a-f0-9]{32}$/) } : {}),
  });
}

export function validateEvent(event: string, payload: unknown) {
  const schema = typeof event === "string" && Object.hasOwn(schemas, event) ? schemas[event] : undefined;
  const parsed = schema?.safeParse(payload);
  return parsed?.success ? parsed.data as Record<string, unknown> : null;
}

export function protectGameEvents(socket: Socket, address: string, roomAttempts: TokenBucket, shared?: { global: TokenBucket; addresses: TokenBucket }): void {
  const traffic = new TokenBucket(80, 20, 1);
  const sync = new TokenBucket(5, 2, 1);
  const voice = new TokenBucket(4, 0.5, 1);
  const clock = new TokenBucket(5, 0.2, 1);
  const confirmations = new TokenBucket(5, 0.5, 1);
  let limitedPackets = 0;
  socket.use((packet, next) => {
    const [event, payload] = packet;
    const ack = packet.at(-1);
    const reject = (error: string, code?: string) => { if (typeof ack === "function") ack({ ok: false, error, ...(code ? { code } : {}) }); };
    const overBudget = (shared && (!shared.global.take("events") || !shared.addresses.take(address))) ||
      !traffic.take("socket") ||
      (event === "room:sync" && !sync.take("sync")) ||
      (event === "voice:join" && !voice.take("voice")) ||
      (event === "clock:sync" && !clock.take("clock")) ||
      (event === "command:status" && !confirmations.take("confirmations"));
    if (overBudget) {
      reject("操作过于频繁，请稍后再试。");
      if (++limitedPackets === 20) socket.disconnect(true);
      return;
    }
    limitedPackets = 0;
    if (isCommand(event) && payload && typeof payload === "object" && !Object.hasOwn(payload, "requestId")) {
      reject("页面版本已更新，请刷新后继续。", "PROTOCOL_MISMATCH");
      return;
    }
    const parsed = validateEvent(event, payload);
    if (!parsed || typeof ack !== "function") { reject("请求格式不正确。"); return; }
    if (["room:create", "room:join"].includes(event)) {
      if (!roomAttempts.take(address)) { reject("创建或加入房间过于频繁。"); return; }
    } else if (event === "voice:join" && (socket.data.playerId !== parsed.playerId || socket.data.roomCode !== parsed.roomCode)) {
      reject("请先恢复当前玩家会话。"); return;
    }
    packet[1] = parsed;
    next();
  });
}
