#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolchainPath = join(root, "config/toolchain.json");
const toolchain = JSON.parse(readFileSync(toolchainPath, "utf8"));
if (toolchain?.schemaVersion !== 1) throw new Error("config/toolchain.json schemaVersion is unsupported");
const nodeMinimum = toolchain.node?.minimum;
const uvVersion = toolchain.uv?.version;
const pythonVersionFile = toolchain.python?.versionFile;
if (typeof nodeMinimum !== "string" || typeof uvVersion !== "string" || typeof pythonVersionFile !== "string") {
  throw new Error("config/toolchain.json is incomplete");
}
const pythonVersion = readFileSync(join(root, pythonVersionFile), "utf8").trim();
if (!/^\d+\.\d+(?:\.\d+)?$/u.test(pythonVersion)) throw new Error(`${pythonVersionFile} is invalid`);
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

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error(`${label} must use major.minor.patch format`);
  return match.slice(1).map(Number);
}

function assertNodeVersion() {
  const actual = parseVersion(process.versions.node, "Node.js runtime version");
  const minimum = parseVersion(nodeMinimum, "config/toolchain.json node.minimum");
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`Node.js ${nodeMinimum} or newer is required; found ${process.versions.node}`);
    }
  }
}

function uvInstaller() {
  for (const kind of ["unix", "windows"]) {
    const installer = toolchain.uv?.installers?.[kind];
    if (!installer || typeof installer.url !== "string" || typeof installer.sha256 !== "string") {
      throw new Error(`config/toolchain.json uv.installers.${kind} is incomplete`);
    }
    if (!installer.url.startsWith("https://")
      || !installer.url.includes(`/uv/${uvVersion}/`)
      || !/^[a-f0-9]{64}$/u.test(installer.sha256)) {
      throw new Error(`config/toolchain.json uv.installers.${kind} is invalid`);
    }
  }
  return toolchain.uv.installers[process.platform === "win32" ? "windows" : "unix"];
}

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

async function downloadVerifiedInstaller(installer, target) {
  const response = await fetch(installer.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${installer.url})`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== installer.sha256) {
    throw new Error(`uv installer checksum mismatch for ${installer.url}`);
  }
  writeFileSync(target, body, { mode: 0o700 });
}

async function installUv() {
  const installerSource = uvInstaller();
  if (existsSync(uvPath) && output(uvPath, ["--version"])?.startsWith(`uv ${uvVersion} `)) return;

  mkdirSync(uvDir, { recursive: true });
  if (process.platform === "win32") {
    const installer = join(toolsDir, "install-uv.ps1");
    await downloadVerifiedInstaller(installerSource, installer);
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
  await downloadVerifiedInstaller(installerSource, installer);
  chmodSync(installer, 0o700);
  try {
    run("sh", [installer], { env: { ...env, UV_UNMANAGED_INSTALL: uvDir } });
  } finally {
    rmSync(installer, { force: true });
  }
}

async function main() {
  assertNodeVersion();
  process.chdir(root);
  mkdirSync(toolsDir, { recursive: true });
  await installUv();

  console.log(`Installing Python ${pythonVersion} inside ${pythonDir}`);
  run(uvPath, ["python", "install", "--no-bin", "--install-dir", pythonDir, pythonVersion]);
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
