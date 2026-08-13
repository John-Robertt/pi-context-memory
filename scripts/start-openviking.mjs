#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = process.platform === "win32"
  ? join(root, ".venv", "Scripts", "openviking-server.exe")
  : join(root, ".venv", "bin", "openviking-server");
const config = join(root, "config", "openviking.json");

if (!existsSync(server)) {
  console.error("Project dependencies are missing. Run: node scripts/install-dependencies.mjs");
  process.exit(1);
}

const child = spawn(server, ["--config", config], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`OpenViking failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
