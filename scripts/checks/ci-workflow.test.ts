import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
type Step = { run?: string; env?: Record<string, string> };
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: { gateway: { steps: Step[] } } };
const commands = workflow.jobs.gateway.steps.flatMap(step => (step.run ?? "").split("\n")
  .filter(line => line.includes("docker compose "))
  .map(run => ({ run, env: step.env ?? {} })));

describe("Compose CI validation", () => {
  it.each([
    { name: "app-only", file: ".env.example", serviceFile: "../.env.example", matches: (run: string) => run.includes("--env-file .env.example ") },
    { name: "standalone", file: "deploy/.env.public.example", serviceFile: ".env.public.example", matches: (run: string) => run.includes("--profile standalone ") },
    { name: "restore", file: "deploy/.env.public.example", serviceFile: ".env.public.example", matches: (run: string) => run.includes("-f deploy/compose.restore.yaml ") },
  ])("binds $name interpolation and service environment to the same public example", ({ name, file, serviceFile, matches }) => {
    const command = commands.find(command => matches(command.run));
    expect(command).toBeDefined();
    expect(command!.env.GAME_ENV_FILE).toBe(serviceFile);
    expect(resolve(root, "deploy", command!.env.GAME_ENV_FILE)).toBe(resolve(root, file));
    expect(existsSync(resolve(root, file))).toBe(true);
    expect(command!.run).toContain(`--env-file ${file} `);
    expect(command!.run).toContain("--quiet");
    expect(command!.run).not.toContain("--no-env-resolution");
    if (name === "restore") expect(command!.env.RESTORE_VOLUME).toBe("avalon_synthetic_restore");
  });

  it("keeps all three profiles and does not weaken the required production environment file", () => {
    expect(commands).toHaveLength(3);
    const compose = parse(readFileSync(resolve(root, "deploy/compose.yaml"), "utf8"));
    expect(compose.services.app.env_file).toBe("${GAME_ENV_FILE:-.env.public}");
  });
});
