import { build } from "esbuild";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildServer(outputRoot = ".") {
  await build({ entryPoints: ["src/server/index.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(outputRoot, "dist-server/server/index.js") });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildServer(process.argv[2]);
