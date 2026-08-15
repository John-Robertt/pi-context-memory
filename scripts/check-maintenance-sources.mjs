#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readProjectOpenVikingVersion,
  readValidationSuite,
} from "./validation-suite.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolchain = JSON.parse(readFileSync(resolve(root, "config/toolchain.json"), "utf8"));
if (toolchain?.schemaVersion !== 1) throw new Error("config/toolchain.json schemaVersion is unsupported");
const suite = readValidationSuite(root);
const openVikingVersion = readProjectOpenVikingVersion(root);
const pythonVersion = readFileSync(resolve(root, toolchain.python.versionFile), "utf8").trim();

function requireVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

const coordinates = {
  pi: requireVersion(suite.host.pi.version, "validation suite Pi version"),
  openViking: requireVersion(openVikingVersion, "OpenViking dependency version"),
  node: requireVersion(toolchain.node?.minimum, "toolchain Node minimum"),
  uv: requireVersion(toolchain.uv?.version, "toolchain uv version"),
  python: requireVersion(pythonVersion, "Python version file"),
  modelRoute: suite.models.route,
};

for (const kind of ["unix", "windows"]) {
  const installer = toolchain.uv?.installers?.[kind];
  if (!installer
    || typeof installer.url !== "string"
    || !installer.url.includes(`/uv/${coordinates.uv}/`)
    || typeof installer.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(installer.sha256)) {
    throw new Error(`config/toolchain.json uv.installers.${kind} is inconsistent`);
  }
}

const pyproject = readFileSync(resolve(root, "pyproject.toml"), "utf8");
const pythonParts = coordinates.python.split(".").map(Number);
const nextMinor = `${pythonParts[0]}.${pythonParts[1] + 1}`;
const requiresPython = /^requires-python\s*=\s*"([^"]+)"$/mu.exec(pyproject)?.[1];
if (!requiresPython?.includes(`>=${coordinates.python}`) || !requiresPython.includes(`<${nextMinor}`)) {
  throw new Error("pyproject.toml requires-python differs from .python-version");
}

const uvLock = readFileSync(resolve(root, "uv.lock"), "utf8");
const lockedOpenVikingVersions = [...uvLock.matchAll(
  /\[\[package\]\]\s+name = "openviking"\s+version = "([^"]+)"/gmu,
)].map((match) => match[1]);
if (lockedOpenVikingVersions.length !== 1 || lockedOpenVikingVersions[0] !== coordinates.openViking) {
  throw new Error("uv.lock OpenViking version differs from pyproject.toml");
}

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
if (listed.status !== 0) throw new Error(listed.stderr.trim() || "Cannot list repository files");
const candidatePaths = listed.stdout.trim().split("\n").filter((path) =>
  path.endsWith(".md")
  || path.startsWith("scripts/")
  || path.startsWith(".pi/extensions/pi-context-memory/"));
const authorities = new Set([
  ".python-version",
  "config/toolchain.json",
  "pyproject.toml",
  "uv.lock",
  "validation/suite.json",
]);
const violations = [];
for (const path of candidatePaths) {
  if (authorities.has(path) || path.startsWith("validation/evidence/")) continue;
  let source;
  try {
    source = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [name, version] of Object.entries(coordinates)) {
    if (source.includes(version)) violations.push(`${path} duplicates ${name} coordinate ${version}`);
  }
}
if (violations.length > 0) throw new Error(violations.join("\n"));

console.log(JSON.stringify({ passed: true, coordinates }, null, 2));
