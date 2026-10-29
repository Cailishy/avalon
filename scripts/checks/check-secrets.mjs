import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenTrackedPath } from "./check-repository.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const physicalRoot = realpathSync(root);
const binary = process.env.GITLEAKS_BIN ?? "gitleaks";
const flags = ["--redact=100", "--no-banner", "--ignore-gitleaks-allow"];
const available = spawnSync(binary, ["version"], { cwd: root, encoding: "utf8", windowsHide: true });
if (available.status !== 0) {
  console.error("Install the official Gitleaks CLI or set GITLEAKS_BIN. No scan was performed.");
  process.exitCode = 1;
} else {
  let snapshot;
  try {
    const candidates = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (candidates.status !== 0) throw new Error("Cannot enumerate candidate files for the public-source scan.");
    const files = [...new Set(candidates.stdout.split("\0").filter(Boolean))];
    const stagedPaths = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (stagedPaths.status !== 0) throw new Error("Cannot inspect staged publication paths.");
    if (stagedPaths.stdout.split("\0").filter(Boolean).some(forbiddenTrackedPath)) throw new Error("Private/generated files are staged; scan refused before reading or exporting their contents.");
    const workingFiles = files.filter(file => {
      const source = path.resolve(root, file);
      if (!source.startsWith(path.resolve(root) + path.sep)) throw new Error("Candidate is outside the workspace; snapshot refused.");
      const info = lstatSync(source, { throwIfNoEntry: false });
      if (!info) return false;
      if (forbiddenTrackedPath(file)) throw new Error("Private/generated files are publication candidates. Run npm run repo:check; no files were read or exported.");
      if (info.isSymbolicLink() || !info.isFile() || !realpathSync(source).startsWith(physicalRoot + path.sep)) throw new Error("Candidate is not a regular in-workspace file; snapshot refused.");
      return true;
    });
    snapshot = mkdtempSync(path.join(tmpdir(), "awalong-secret-check-"));
    for (const file of workingFiles) {
      const source = path.resolve(root, file);
      if (!source.startsWith(path.resolve(root) + path.sep)) throw new Error("Candidate is outside the workspace; snapshot refused.");
      const info = lstatSync(source, { throwIfNoEntry: false });
      // Git still lists deleted or moved tracked files until the change is staged.
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile() || !realpathSync(source).startsWith(physicalRoot + path.sep)) throw new Error("Candidate is not a regular in-workspace file; snapshot refused.");
      const target = path.join(snapshot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target);
    }
    // Only Git-visible candidates are copied; ignored private environment/data stay untouched.
    const history = spawnSync(binary, ["git", ...flags, "--log-opts=--all", root], { stdio: "inherit", windowsHide: true });
    const staged = spawnSync(binary, ["git", ...flags, "--pre-commit", "--staged", root], { stdio: "inherit", windowsHide: true });
    const working = spawnSync(binary, ["dir", ...flags, snapshot], { stdio: "inherit", windowsHide: true });
    if (history.status !== 0 || staged.status !== 0 || working.status !== 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Secret scan failed.");
    process.exitCode = 1;
  } finally {
    if (snapshot) {
      const target = path.resolve(snapshot);
      // eslint-disable-next-line no-unsafe-finally -- Never recursively remove an unverified directory.
      if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("awalong-secret-check-")) throw new Error("Unsafe secret-scan cleanup path.");
      rmSync(target, { recursive: true, force: true });
    }
  }
}
