import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist-server/server/index.js"], { stdio: "inherit", env: { ...process.env, APP_MODE: "public" } });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", code => { process.exitCode = code ?? 1; });
