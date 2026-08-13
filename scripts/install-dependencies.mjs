#!/usr/bin/env node

import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uvVersion = "0.11.31";
const pythonVersion = "3.12";
const toolsDir = join(root, ".tools");
const uvDir = join(toolsDir, "uv");
const pythonDir = join(toolsDir, "python");
const cacheDir = join(root, ".cache", "uv");
const uvName = process.platform === "win32" ? "uv.exe" : "uv";
const uvPath = join(uvDir, uvName);
const env = {
  ...process.env,
  UV_CACHE_DIR: cacheDir,
  UV_PYTHON_INSTALL_DIR: pythonDir,
  UV_PROJECT_ENVIRONMENT: join(root, ".venv"),
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }
  await pipeline(response.body, createWriteStream(target, { mode: 0o700 }));
}

async function installUv() {
  if (existsSync(uvPath) && output(uvPath, ["--version"])?.startsWith(`uv ${uvVersion} `)) return;

  mkdirSync(uvDir, { recursive: true });
  if (process.platform === "win32") {
    const installer = join(toolsDir, "install-uv.ps1");
    await download(`https://astral.sh/uv/${uvVersion}/install.ps1`, installer);
    try {
      run("powershell", [
        "-NoProfile",
        "-ExecutionPolicy", "ByPass",
        "-File", installer,
      ], { env: { ...env, UV_UNMANAGED_INSTALL: uvDir } });
    } finally {
      rmSync(installer, { force: true });
    }
    return;
  }

  const installer = join(toolsDir, "install-uv.sh");
  await download(`https://astral.sh/uv/${uvVersion}/install.sh`, installer);
  chmodSync(installer, 0o700);
  try {
    run("sh", [installer], { env: { ...env, UV_UNMANAGED_INSTALL: uvDir } });
  } finally {
    rmSync(installer, { force: true });
  }
}

async function main() {
  process.chdir(root);
  mkdirSync(toolsDir, { recursive: true });
  await installUv();

  console.log(`Installing Python ${pythonVersion} inside ${pythonDir}`);
  run(uvPath, ["python", "install", "--install-dir", pythonDir, pythonVersion]);
  const managedPython = output(uvPath, ["python", "find", "--managed-python", pythonVersion]);
  if (!managedPython) throw new Error(`Project-local Python ${pythonVersion} is unavailable after installation`);

  console.log("Synchronizing locked OpenViking dependencies into .venv");
  run(uvPath, ["sync", "--locked", "--no-dev", "--python", managedPython]);
  const venvPython = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  run(uvPath, ["pip", "check", "--python", venvPython]);

  const server = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "openviking-server.exe")
    : join(root, ".venv", "bin", "openviking-server");
  if (!existsSync(server)) throw new Error(`OpenViking server entry point is missing: ${server}`);

  console.log("\nDependencies are ready.");
  console.log("Next:");
  console.log("  node scripts/start-openviking.mjs");
  console.log("  pi");
}

main().catch((error) => {
  console.error(`Dependency installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
