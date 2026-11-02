import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "./build-server.mjs";

const outputRoot = ".media/server-build-test";

afterEach(() => {
  rmSync(outputRoot, { recursive: true, force: true });
});

describe("server build entrypoint", () => {
  it("resolves the server entry from the project root", async () => {
    await buildServer(outputRoot);
    expect(existsSync(join(outputRoot, "dist-server/server/index.js"))).toBe(true);
  }, 30_000);
});
