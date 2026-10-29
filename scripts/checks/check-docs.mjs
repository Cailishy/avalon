import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenTrackedPath } from "./check-repository.mjs";

const outside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

export function inspectDocumentation(root) {
  root = path.resolve(root);
  const physicalRoot = realpathSync(root);
  const documents = [], errors = [];
  let checkedLinks = 0;
  const scan = (directory, recursive) => {
    if (forbiddenTrackedPath(path.relative(root, directory))) return;
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) { errors.push("Documentation directories must not be symlinks."); return; }
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (forbiddenTrackedPath(path.relative(root, file))) continue;
      if (item.isSymbolicLink()) { errors.push(`Documentation symlink: ${path.relative(root, file)}`); continue; }
      if (recursive && item.isDirectory()) scan(file, true);
      else if (item.isFile() && item.name.endsWith(".md")) documents.push(file);
    }
  };
  scan(root, false);
  scan(path.join(root, "docs"), true);
  scan(path.join(root, "public"), true);
  // Check local inline links/images without fetching remote URLs or validating anchors.
  for (const file of documents) {
    let fence;
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      for (const match of line.replace(/`+[^`]*`+/g, "").matchAll(/\[[^\]\r\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
        const target = match[1].replace(/^<|>$/g, "");
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue;
        const location = `${path.relative(root, file).replaceAll("\\", "/")}:${index + 1}`;
        try {
          const resolved = path.resolve(path.dirname(file), decodeURIComponent(target.split(/[?#]/)[0]));
          if (outside(root, resolved) || forbiddenTrackedPath(path.relative(root, resolved)) || !existsSync(resolved) || outside(physicalRoot, realpathSync(resolved))) throw new Error("Missing, private or out-of-workspace target");
          checkedLinks++;
        } catch { errors.push(`Invalid local link at ${location}: ${target}`); }
      }
    }
  }
  return { errors, documents: documents.length, checkedLinks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectDocumentation(fileURLToPath(new URL("../../", import.meta.url)));
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  console.log(`Documentation check: ${result.documents} document(s), ${result.checkedLinks} valid local link(s), ${result.errors.length} error(s).`);
  if (result.errors.length) process.exitCode = 1;
}
