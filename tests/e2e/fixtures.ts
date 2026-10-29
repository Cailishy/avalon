import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface TestGame { url: string; passcode: string; restart: () => Promise<void> }

export const test = base.extend<{ game: TestGame }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  game: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "awalong-e2e-"));
    const root = resolve(process.env.GAME_BUILD_ROOT ?? ".media/e2e-build");
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Missing isolated test port.");
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const passcode = randomBytes(24).toString("base64url");
    let child: ChildProcess | null = null;
    async function stop() {
      if (!child) return;
      const process = child; child = null;
      if (process.exitCode !== null || process.signalCode !== null) return;
      const stopped = new Promise(resolve => process.once("exit", resolve));
      process.kill("SIGKILL");
      await stopped;
    }
    async function start() {
      const processChild = spawn(process.execPath, [join(root, "dist-server/server/index.js")], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "production", APP_MODE: "lan", PUBLIC_ORIGIN: "", GAME_ACCESS_CODE: passcode,
          HOST: "127.0.0.1", PORT: String(port), ROOM_STORE_PATH: join(directory, "rooms.sqlite"), VOICE_REQUIRED: "false",
          LIVEKIT_URL: "", LIVEKIT_API_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" },
      });
      child = processChild;
      let ready = false; let failed = false;
      processChild.stdout?.on("data", bytes => { if (bytes.toString().includes(`server running at http://localhost:${port}`)) ready = true; });
      processChild.stderr?.resume();
      processChild.once("error", () => { failed = true; });
      const until = Date.now() + 15000;
      while (!ready) {
        if (failed || processChild.exitCode !== null || processChild.signalCode !== null || Date.now() > until) throw new Error("Isolated E2E server failed to start; run npm run build:e2e first.");
        await sleep(25);
      }
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    }
    try {
      await start();
      await use({ url, passcode, restart: async () => { await stop(); await start(); } });
    } finally {
      await stop();
      const target = resolve(directory);
      // eslint-disable-next-line no-unsafe-finally -- Never recursively remove an unverified directory.
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("awalong-e2e-")) throw new Error("Unsafe E2E cleanup path.");
      await rm(target, { recursive: true, force: true });
    }
  },
});
export { expect };
