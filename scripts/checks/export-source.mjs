import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { forbiddenTrackedPath, inspectRepository, requiredFiles } from "./check-repository.mjs";
import { inspectDocumentation } from "./check-docs.mjs";

const rootFiles = [...new Set([
  ...requiredFiles.filter(file => !file.includes("/")), ".dockerignore", "index.html", "access.html",
  "tsconfig.json", "vite.config.ts", "vitest.config.ts", "playwright.config.ts", "docs/README.md",
])];
const publicDirectories = ["src", "tests", "scripts", "public", "deploy", ".github", "docs/user-guide", "docs/deployment", "docs/development", "docs/media", "docs/images"];
const sourceExtension = /\.(?:ts|tsx|mjs|js|css|json|html|md|txt|png|jpe?g|webp|gif|svg|ogg|mp3|wav|zip|webmanifest|ya?ml|caddy)$/i;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function publicSourceFiles(root) {
  root = realpathSync(root);
  const files = new Set();
  const add = file => {
    if (forbiddenTrackedPath(file)) return;
    const target = path.join(root, file);
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || !inside(root, realpathSync(target))) throw new Error(`Not a regular public source file: ${file}`);
    files.add(file);
  };
  const walk = directory => {
    if (forbiddenTrackedPath(directory)) return;
    const target = path.join(root, directory);
    if (!existsSync(target)) return;
    const info = lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, realpathSync(target))) throw new Error(`Not a regular public source directory: ${directory}`);
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (forbiddenTrackedPath(file)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        if (!sourceExtension.test(file) && !["deploy/Caddyfile", "deploy/Caddyfile.existing", "deploy/.env.public.example"].includes(file)) throw new Error(`Unexpected source file type; review before export: ${file}`);
        add(file);
      } else throw new Error(`Not a regular source entry: ${file}`);
    }
  };
  for (const file of rootFiles) if (existsSync(path.join(root, file))) add(file);
  for (const directory of publicDirectories) walk(directory);
  return [...files].sort();
}

export function exportPublicSource(root, name, verify) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) throw new Error("Use a new lowercase source snapshot name without paths.");
  if (typeof verify !== "function") throw new Error("A snapshot verification step is required.");
  root = realpathSync(root);
  const files = publicSourceFiles(root);
  let parent = root;
  for (const part of [".media", "exports"]) {
    parent = path.join(parent, part);
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, realpathSync(parent))) throw new Error("Export parent must be a real in-workspace directory.");
  }
  const destination = path.join(parent, name);
  if (existsSync(destination)) throw new Error("Source snapshot already exists; it will not be overwritten.");
  const staging = mkdtempSync(path.join(parent, ".pending-"));
  let published = false;
  try {
    for (const file of files) {
      const source = path.join(root, file);
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink() || !inside(root, realpathSync(source))) throw new Error("Source changed during export; snapshot refused.");
      const target = path.join(staging, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    const verification = verify(staging, files);
    if (verification === false || verification && typeof verification.then === "function") throw new Error("Source verification must complete successfully and synchronously.");
    if (existsSync(destination)) throw new Error("Source destination changed during verification; refusing to overwrite.");
    renameSync(staging, destination);
    published = true;
    return { directory: destination, files };
  } finally {
    if (!published) {
      // eslint-disable-next-line no-unsafe-finally -- Never remove an unverified cleanup directory.
      if (path.dirname(staging) !== parent || !path.basename(staging).startsWith(".pending-") || realpathSync(parent) !== parent) throw new Error("Unsafe source snapshot cleanup path.");
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error("Usage: npm run source:export -- optional-snapshot-name");
    const binary = process.env.GITLEAKS_BIN ?? "gitleaks";
    if (spawnSync(binary, ["version"], { windowsHide: true, stdio: "ignore" }).status !== 0) throw new Error("Install Gitleaks or set GITLEAKS_BIN; no source snapshot was exported.");
    const result = exportPublicSource(fileURLToPath(new URL("../../", import.meta.url)), process.argv[2] ?? "avalon-source", (directory, files) => {
      const repository = inspectRepository(directory, { trackedFiles: files, dirty: false });
      const documentation = inspectDocumentation(directory);
      if (repository.errors.length || documentation.errors.length) throw new Error([...repository.errors, ...documentation.errors].join("\n"));
      for (const warning of repository.warnings) console.warn(`WARN: ${warning}`);
      const scan = spawnSync(binary, ["dir", "--redact=100", "--no-banner", "--ignore-gitleaks-allow", directory], { windowsHide: true, stdio: "inherit" });
      if (scan.status !== 0) throw new Error("Public source secret scan did not pass; final snapshot was not created.");
    });
    console.log(`Exported ${result.files.length} public source files to ${result.directory}`);
    console.log("No Git history, local maintenance, credentials or running data were included. This command does not publish or certify a release.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Source export failed.");
    process.exitCode = 1;
  }
}
