import { build } from "vite";
import { buildServer } from "./build-server.mjs";

const outputRoot = ".media/e2e-build";
await build({ build: { outDir: `${outputRoot}/dist` } });
await buildServer(outputRoot);
