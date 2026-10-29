import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import express from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import { attachSocketHandlers } from "./socketHandlers";
import { createAccessGate } from "./accessGate";
import { readConfig } from "./config";
import { ConnectionQuota, requestPolicy } from "./security";
import { VoiceService, checkOptionalVoice } from "./voice";
import { RoomStore } from "./roomStore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
if (existsSync(path.join(root, ".env"))) loadEnvFile(path.join(root, ".env"));
if (process.env.APP_MODE !== "public" && existsSync(path.join(root, ".media/voice.env"))) loadEnvFile(path.join(root, ".media/voice.env"));
const isDev = process.argv.includes("--dev");
const config = readConfig(process.env, isDev);
const store = new RoomStore(config.roomStorePath);
const { port, host } = config;
const localUrls = config.origin ? [config.origin] : getLocalUrls(port);
const app = express();
const server = http.createServer(app);
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
const network = requestPolicy(config);
const access = createAccessGate(config.passcode, Date.now, network, store.accessKey(config.passcode));
const quota = new ConnectionQuota();
const reservations = new WeakMap<http.IncomingMessage, { release: () => void; timeout: NodeJS.Timeout }>();
const io = new Server(server, {
  cors: { origin: config.origin ?? false, credentials: true },
  maxHttpBufferSize: 16 * 1024,
  connectTimeout: 10_000,
  allowRequest: (req, done) => {
    if (!network.originAllowed(req) || !access.hasAccess(req)) { done("Unauthorized", false); return; }
    const release = quota.acquire(network.address(req));
    if (!release) { done("Connection limit", false); return; }
    const timeout = setTimeout(release, 15_000);
    timeout.unref();
    reservations.set(req, { release, timeout });
    done(null, true);
  },
});
io.engine.use(network.guard);
io.engine.on("connection", socket => {
  const reservation = reservations.get(socket.request);
  if (reservation) { clearTimeout(reservation.timeout); reservations.delete(socket.request); socket.once("close", reservation.release); }
});
app.disable("x-powered-by");
app.set("trust proxy", config.publicMode ? config.trustProxy : false);
app.set("query parser", "simple");
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: isDev ? ["'self'", "'unsafe-eval'"] : ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"], mediaSrc: ["'self'", "blob:"],
    connectSrc: ["'self'", ...(config.publicMode ? [config.origin!.replace(/^https/, "wss")] : ["ws:", "wss:"]), ...(config.voice ? [config.voice.url, config.voice.url.replace(/^ws/, "http")] : [])],
    objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    upgradeInsecureRequests: config.publicMode ? [] : null,
  } },
  strictTransportSecurity: config.publicMode ? { maxAge: 31_536_000 } : false,
}));
app.use((_req, res, next) => { res.set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()"); next(); });
app.get("/healthz", (_req, res) => res.set("Cache-Control", "no-store").status(runtime.isHealthy() ? 200 : 503).json({ ok: runtime.isHealthy() }));
app.use(network.middleware);
app.use("/api/access", access.router);
access.protectSockets(io);
const voice = new VoiceService(config.voice);
if (config.voice) await checkOptionalVoice(voice, config.voiceRequired);
const runtime = attachSocketHandlers(io, localUrls, { address: network.address, voice, store, limits: { codeLength: config.publicMode ? 8 : 5 } });

await configureApp();
const errorHandler: express.ErrorRequestHandler = (_error, _req, res, _next) => {
  if (!res.headersSent) res.status(500).json({ ok: false, error: "服务暂时不可用。" });
};
app.use(errorHandler);

server.listen(port, host, () => {
  console.log(`Avalon server running at http://localhost:${port}`);
  for (const url of localUrls) console.log(`LAN: ${url}`);
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  await runtime.close();
  io.close(() => { clearTimeout(timeout); process.exit(0); });
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

async function configureApp(): Promise<void> {
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    const renderAccess = async () => vite.transformIndexHtml("/access.html", await readFile(path.join(root, "access.html"), "utf8"));
    app.use(access.protectPages(renderAccess));
    app.use(vite.middlewares);
    app.use("*", access.protectPages(renderAccess, true), async (req, res, next) => {
      try {
        const url = req.originalUrl;
        const html = await vite.transformIndexHtml(url, await import("node:fs/promises").then((fs) => fs.readFile(path.join(root, "index.html"), "utf8")));
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
    return;
  }

  const dist = path.join(root, "dist");
  const renderAccess = () => readFile(path.join(dist, "access.html"), "utf8");
  app.use(access.protectPages(renderAccess));
  app.use(express.static(dist));
  app.get("*", access.protectPages(renderAccess, true), (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

function getLocalUrls(serverPort: number): string[] {
  const urls = [`http://localhost:${serverPort}`];
  const interfaces = os.networkInterfaces();
  for (const values of Object.values(interfaces)) {
    for (const item of values ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${serverPort}`);
      }
    }
  }
  return urls;
}
