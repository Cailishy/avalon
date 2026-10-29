import crypto from "node:crypto";
import path from "node:path";
import express, { type Request, type RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import type { Server } from "socket.io";

const COOKIE_NAME = "awalong-access";
const SESSION_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 60_000;
const MAX_FAILURES = 5;
const MAX_TRACKED_IPS = 4096;

export function createAccessGate(passcode: string, now: () => number = Date.now, policy: {
  originAllowed?: (req: IncomingMessage) => boolean;
  secure?: (req: IncomingMessage) => boolean;
  address?: (req: IncomingMessage) => string;
} = {}, signingKey?: Buffer) {
  if (!passcode.trim() || passcode.length > 128) {
    throw new Error("Set GAME_ACCESS_CODE in .env or the server environment (1-128 characters).");
  }
  if (signingKey && signingKey.length !== 32) throw new Error("Invalid entrance signing key.");
  const secret = signingKey ? Buffer.from(signingKey) : crypto.randomBytes(32);
  const expectedCode = digest(passcode);
  const failures = new Map<string, { count: number; until: number }>();
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.post("/", express.json({ limit: "1kb", inflate: false }), (req, res) => {
    if (!(policy.originAllowed ?? sameOrigin)(req)) {
      res.status(403).json({ ok: false, error: "请从游戏页面提交暗号。" });
      return;
    }
    const time = now();
    for (const [ip, entry] of failures) if (entry.until <= time) failures.delete(ip);
    const ip = policy.address?.(req) ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    const attempts = failures.get(ip);
    if ((attempts && attempts.count >= MAX_FAILURES) || (!attempts && failures.size >= MAX_TRACKED_IPS)) {
      const retry = Math.max(1, Math.ceil(((attempts?.until ?? time + RETRY_MS) - time) / 1000));
      res.set("Retry-After", String(retry)).status(429).json({ ok: false, error: `尝试过于频繁，请 ${retry} 秒后重试。` });
      return;
    }
    const code: unknown = req.body?.code;
    if (typeof code !== "string" || code.length > 128 || !crypto.timingSafeEqual(digest(code), expectedCode)) {
      failures.set(ip, { count: (attempts?.count ?? 0) + 1, until: attempts?.until ?? time + RETRY_MS });
      res.status(401).json({ ok: false, error: "暗号不正确，请重新输入。" });
      return;
    }
    failures.delete(ip);
    const token = `${crypto.randomBytes(16).toString("base64url")}.${time + SESSION_MS}`;
    res.cookie(COOKIE_NAME, `${token}.${sign(token)}`, {
      httpOnly: true, sameSite: "strict", secure: policy.secure?.(req) ?? req.secure, path: "/", maxAge: SESSION_MS,
    });
    res.json({ ok: true });
  });
  router.use((_req, res) => res.status(405).json({ ok: false, error: "不支持的请求。" }));
  const errors: express.ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ ok: false, error: "暗号格式不正确。" });
  };
  router.use(errors);

  function sign(value: string): string {
    return crypto.createHmac("sha256", secret).update(value).digest("base64url");
  }

  function accessDeadline(req: IncomingMessage): number | null {
    const cookies = (req.headers.cookie ?? "").split(";").map(cookie => cookie.trim());
    const matches = cookies.filter(cookie => cookie.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(COOKIE_NAME.length + 1);
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [nonce, expiry, signature] = parts;
    if (!/^[\w-]{22}$/.test(nonce) || !/^\d{13}$/.test(expiry) || !/^[\w-]{43}$/.test(signature)) return null;
    const remaining = Number(expiry) - now();
    return remaining > 0 && remaining <= SESSION_MS && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(`${nonce}.${expiry}`))) ? Number(expiry) : null;
  }

  function hasAccess(req: IncomingMessage): boolean {
    return accessDeadline(req) !== null;
  }

  function protectPages(renderAccess: (req: Request) => Promise<string>, forceDocument = false): RequestHandler {
    return (req, res, next) => {
      // Bundles and artwork are public; documents and game sockets are not.
      const isDocument = forceDocument || req.get("Sec-Fetch-Dest") === "document" || req.path.endsWith(".html") || !path.extname(req.path);
      if (req.path.startsWith("/api/")) {
        res.status(404).json({ ok: false, error: "接口不存在。" });
        return;
      }
      if (!forceDocument && (!isDocument || req.path.startsWith("/@")) && req.path !== "/") return next();
      res.set("Cache-Control", "no-store");
      res.vary("Cookie");
      if (hasAccess(req)) return next();
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.sendStatus(401);
        return;
      }
      renderAccess(req).then(html => res.type("html").send(html)).catch(next);
    };
  }

  function protectSockets(io: Server): void {
    io.use((socket, next) => {
      const deadline = accessDeadline(socket.request);
      if (!(policy.originAllowed ?? sameOrigin)(socket.request) || deadline === null) {
        const error = new Error("请先输入暗号进入游戏。");
        next(Object.assign(error, { data: { code: "ACCESS_REQUIRED" } }));
        return;
      }
      const expire = () => {
        socket.emit("access:required");
        socket.disconnect(true);
      };
      const expiryTimer = setTimeout(expire, deadline - now());
      expiryTimer.unref();
      socket.on("disconnect", () => clearTimeout(expiryTimer));
      // Recheck each command so a long-lived connection cannot outlive its entrance session.
      socket.use((_packet, nextPacket) => {
        if (hasAccess(socket.request)) return nextPacket();
        expire();
      });
      next();
    });
  }

  return { router, hasAccess, protectPages, protectSockets };
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host === req.headers.host;
  } catch {
    return false;
  }
}
