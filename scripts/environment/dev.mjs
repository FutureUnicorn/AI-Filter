import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const localEnvironmentFile = path.join(repositoryRoot, ".env.local");

if (fs.existsSync(localEnvironmentFile)) {
  process.loadEnvFile(localEnvironmentFile);
}

const target = process.argv[2];
const targetArguments =
  target === "web"
    ? ["apps/web/node_modules/next/dist/bin/next", "dev", "apps/web"]
    : target === "worker"
      ? ["apps/worker/src/index.ts"]
      : undefined;

if (targetArguments === undefined) {
  throw new Error("Expected web or worker development target");
}

const child = spawn(process.execPath, targetArguments, {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  throw error;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
