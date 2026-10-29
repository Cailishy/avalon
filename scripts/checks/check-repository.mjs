import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { z } from "zod";

export const requiredFiles = [
  "LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md",
  ".editorconfig", "eslint.config.mjs", ".gitignore", ".env.example", "package.json", "package-lock.json", "Dockerfile",
  ".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/VULNERABILITY_REPORT.yml", ".github/pull_request_template.md", ".github/dependabot.yml", ".github/workflows/ci.yml", ".github/workflows/secrets.yml",
  "docs/media/licensing.md", "docs/development/releasing.md", "docs/development/security.md", "docs/media/assets.json", "docs/deployment/README.md", "docs/development/architecture.md",
  "public/assets/LICENSE.md", "public/assets/MIT-LICENSE.txt", "public/assets/narration/NOTICE.md", "public/assets/ATTRIBUTION.md", "docs/media/provenance.md", "deploy/Caddyfile.existing", "deploy/caddy-policy.caddy",
  "scripts/checks/check-repository.mjs", "scripts/checks/check-secrets.mjs", "scripts/deploy/deployment.mjs",
  "docs/README.md", "docs/user-guide/rules.md", "docs/development/testing.md", "scripts/checks/check-docs.mjs",
  "deploy/compose.yaml", "deploy/compose.restore.yaml", "deploy/.env.public.example", "deploy/Caddyfile",
];

const relativePath = z.string().min(1).refine(value => !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.includes("\\") && !value.split("/").some(part => part === ".." || part === "."));
const reviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assetGroups: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]+$/), paths: z.array(relativePath).min(1),
    license: z.string().min(1).nullable(), approval: z.enum(["pending_review", "approved"]),
    reviewedBy: z.string().min(1).nullable(), reviewedOn: z.string().nullable(),
    evidence: z.array(z.string().min(1)), notes: z.string(),
    reviewedFiles: z.array(z.strictObject({ file: relativePath, bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
  })).min(1),
});

export function forbiddenTrackedPath(file) {
  const name = file.replaceAll("\\", "/");
  if ([".env.example", "deploy/.env.public.example"].includes(name)) return false;
  return /(^|\/)(?:\.env(?:\.[^/]*)?|\.media|\.tools|\.claude|\.codex|\.agents|\.aws|node_modules|data|dist|dist-server|coverage)(?:\/|$)/i.test(name)
    || /^docs\/(?:maintainers|archive)(?:\/|$)/i.test(name)
    || /(?:^|\/)(?:id_rsa|id_ed25519|auth\.json|gitleaks-report\.[^/]+)$/i.test(name)
    || /\.(?:(?:sqlite3?|db)(?:-journal|-wal|-shm)?|pem|key|p12|pfx|log|tsbuildinfo)$/i.test(name);
}

function githubRepository(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash
      && /^\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/(?:owner|your-org|example)\//i.test(url.pathname) && !url.pathname.endsWith(".git");
  } catch { return false; }
}

export function inspectRepository(root, { release = false, trackedFiles, dirty } = {}) {
  root = path.resolve(root);
  const errors = [];
  const warnings = [];
  const read = file => readFileSync(path.join(root, file), "utf8");
  const pending = message => (release ? errors : warnings).push(message);
  const json = file => {
    try { return JSON.parse(read(file)); }
    catch { errors.push(`Invalid or unreadable JSON: ${file}`); return null; }
  };
  for (const file of requiredFiles) {
    const target = path.join(root, file);
    if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) errors.push(`Missing regular project file: ${file}`);
  }
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  if (pkg?.license !== "MIT") errors.push("package.json must declare the approved MIT code license.");
  if (pkg?.private !== true) errors.push("Keep private:true until an npm publication is separately approved.");
  const repositoryUrl = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  if (repositoryUrl === undefined || repositoryUrl === null || repositoryUrl === "") pending("The real GitHub repository URL is not configured in package.json.");
  else if (typeof repositoryUrl !== "string" || !githubRepository(repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, ""))) errors.push("repository must be a real HTTPS GitHub repository URL without credentials or placeholders.");
  if (lock && pkg && (lock.version !== pkg.version || lock.packages?.[""]?.license !== pkg.license || lock.packages?.[""]?.version !== pkg.version)) errors.push("Package and lockfile root version/license must match.");
  for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
    if (!entry.resolved) continue;
    try {
      const url = new URL(entry.resolved);
      if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(".tgz") || typeof entry.integrity !== "string" || !entry.integrity.trim()) throw new Error("Untrusted resolution");
    } catch { errors.push(`Package resolution must use the official HTTPS registry and integrity: ${name}`); }
  }
  for (const name of ["check", "lint", "typecheck", "test", "repo:check", "release:check"]) if (typeof pkg?.scripts?.[name] !== "string") errors.push(`Missing script: ${name}`);
  if (existsSync(path.join(root, "LICENSE")) && !read("LICENSE").includes("Permission is hereby granted, free of charge")) errors.push("MIT license text is incomplete.");

  const yamlFiles = requiredFiles.filter(file => /\.ya?ml$/.test(file));
  for (const file of yamlFiles) {
    if (!existsSync(path.join(root, file))) continue;
    let value;
    try {
      const document = parseDocument(read(file), { uniqueKeys: true });
      if (document.errors.length) throw new Error("Invalid YAML");
      value = document.toJS({ maxAliasCount: 20 });
    } catch { errors.push(`Invalid YAML: ${file}`); continue; }
    if (["bug_report.yml", "feature_request.yml", "VULNERABILITY_REPORT.yml"].includes(path.basename(file))) {
      if (!value?.name || !value?.description || !Array.isArray(value.body) || !value.body.length) { errors.push(`Incomplete GitHub form: ${file}`); continue; }
      const ids = new Set();
      for (const item of value.body) {
        if (!["markdown", "input", "textarea", "dropdown", "checkboxes"].includes(item?.type) || !item.attributes) errors.push(`Invalid form field: ${file}`);
        if (item.type !== "markdown") {
          if (!/^[a-z][a-z0-9_-]*$/.test(item.id ?? "") || ids.has(item.id) || !item.attributes?.label) errors.push(`Invalid/duplicate form id or label: ${file}`);
          ids.add(item.id);
        }
      }
    }
    if (file.endsWith("ISSUE_TEMPLATE/config.yml") && value?.blank_issues_enabled !== false) errors.push("Public blank issues must not bypass the privacy guidance.");
    if (file.endsWith("dependabot.yml") && (value?.version !== 2 || !["npm", "github-actions", "docker"].every(kind => value.updates?.some(item => item["package-ecosystem"] === kind)))) errors.push("Dependabot must cover npm, actions and the app image.");
  }

  const record = reviewSchema.safeParse(json("docs/media/assets.json"));
  if (!record.success) errors.push("Invalid asset manifest schema; no permissions were inferred.");
  else {
    const review = record.data;
    const ids = new Set();
    for (const group of review.assetGroups) {
      if (ids.has(group.id)) errors.push(`Duplicate asset group: ${group.id}`);
      ids.add(group.id);
      if (group.approval !== "approved") pending(`Asset permission review pending: ${group.id}`);
      else if (!group.license || !group.reviewedBy?.trim() || !group.reviewedOn || !/^\d{4}-\d{2}-\d{2}$/.test(group.reviewedOn) || Number.isNaN(Date.parse(group.reviewedOn)) || new Date(group.reviewedOn).toISOString().slice(0, 10) !== group.reviewedOn || !group.evidence.length) errors.push(`Approved group lacks license, reviewer, valid date or evidence: ${group.id}`);
      for (const candidate of group.paths) if (!candidate.startsWith("public/assets/") || !existsSync(path.join(root, candidate))) errors.push(`Missing or out-of-scope asset path in group: ${group.id}`);
      for (const evidence of group.evidence) {
        if (evidence.startsWith("https://")) {
          try { const url = new URL(evidence); if (url.username || url.password || url.search) throw new Error("Credentials or query"); }
          catch { errors.push(`Invalid evidence URL in group: ${group.id}`); }
        } else if (!relativePath.safeParse(evidence).success || forbiddenTrackedPath(evidence) || !existsSync(path.join(root, evidence))) errors.push(`Missing local evidence in group: ${group.id}`);
      }
    }
    const media = new Map();
    const walk = directory => {
      if (!existsSync(path.join(root, directory))) return;
      if (lstatSync(path.join(root, directory)).isSymbolicLink()) { errors.push(`Asset symlinks are not supported: ${directory}`); return; }
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const file = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) { errors.push(`Asset symlinks are not supported: ${file}`); continue; }
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /\.(?:png|jpe?g|webp|gif|svg|ogg|mp3|wav|zip)$/i.test(file)) {
          const matches = review.assetGroups.filter(group => group.paths.some(candidate => file === candidate || (candidate.endsWith("/") && file.startsWith(candidate))));
          if (matches.length !== 1) errors.push(`Media must match exactly one permission group: ${file}`);
          else media.set(file, matches[0].id);
        }
      }
    };
    if (existsSync(path.join(root, "public")) && lstatSync(path.join(root, "public")).isSymbolicLink()) errors.push("Asset parent public/ must not be a symlink.");
    else walk("public/assets");
    for (const group of review.assetGroups.filter(group => group.approval === "approved")) {
      const reviewed = group.reviewedFiles ?? [];
      if (!reviewed.length) errors.push(`Approved group requires a reviewed file/hash inventory: ${group.id}`);
      const seen = new Set();
      for (const item of reviewed) {
        if (seen.has(item.file) || media.get(item.file) !== group.id) { errors.push(`Invalid or duplicate reviewed file in group: ${group.id}`); continue; }
        seen.add(item.file);
        try {
          const bytes = readFileSync(path.join(root, item.file));
          if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) errors.push(`Reviewed asset changed; repeat source/license review: ${item.file}`);
        } catch { errors.push(`Cannot verify reviewed asset: ${item.file}`); }
      }
      for (const [file, id] of media) if (id === group.id && !seen.has(file)) errors.push(`Asset is not in the approved hash inventory: ${file}`);
    }
  }

  if (trackedFiles === undefined) {
    const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) errors.push("Cannot inspect tracked files; run in the project Git checkout.");
    trackedFiles = result.stdout?.split("\0").filter(Boolean) ?? [];
  }
  for (const file of trackedFiles) if (forbiddenTrackedPath(file)) {
    if (!release && file === ".claude/settings.json" && !existsSync(path.join(root, file))) warnings.push("Removed local tool settings are still in the Git index; include their deletion in the next commit.");
    else errors.push(`Private/generated path is tracked: ${JSON.stringify(file)}`);
  }
  const missing = requiredFiles.filter(file => !trackedFiles.includes(file));
  if (missing.length) pending(`${missing.length} required project files are not tracked by Git yet.`);
  if (release) {
    if (dirty === undefined) {
      const status = spawnSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
      dirty = status.status !== 0 || Boolean(status.stdout);
    }
    if (dirty) errors.push("Release requires a clean committed checkout; this command does not commit or delete files.");
  }
  return { errors, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== "--release")) { console.error("Usage: node scripts/checks/check-repository.mjs [--release]"); process.exitCode = 1; }
  else {
    const result = inspectRepository(fileURLToPath(new URL("../../", import.meta.url)), { release: args.includes("--release") });
    for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    console.log(`Repository check: ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
    if (result.errors.length) process.exitCode = 1;
  }
}
