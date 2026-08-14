#!/usr/bin/env node
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  atomicWriteJson,
  compileOpenVikingConfig,
  MEMORY_MODEL_CREDENTIAL_ENV,
  MemoryModelConfigurationError,
  OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS,
  readMemoryModelSetting,
  readOptionalJson,
  runtimePaths,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = runtimePaths(root);
const serverExecutable = process.env.PCR_OPENVIKING_SERVER ?? (process.platform === "win32"
  ? join(root, ".venv", "Scripts", "openviking-server.exe")
  : join(root, ".venv", "bin", "openviking-server"));
const readinessTimeoutMs = positiveInteger(process.env.PCR_OPENVIKING_READINESS_TIMEOUT_MS, 30_000);
const stopTimeoutMs = positiveInteger(process.env.PCR_OPENVIKING_STOP_TIMEOUT_MS, 5_000);
const operationTimeoutMs = OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS + (4 * stopTimeoutMs) + readinessTimeoutMs + 5_000;
const launchId = randomUUID();
const intentionalStops = new WeakSet();
let child;
let ownedAddress;
let lifecycleLockHandle;
let currentState;
let stateWriteQueue = Promise.resolve();
let currentOperation;
let shutdownPromise;
let shuttingDown = false;

class PreflightError extends Error {}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

function stableHash(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquireLifecycleLock() {
  try {
    lifecycleLockHandle = await open(paths.lifecycleLock, "wx", 0o600);
    await lifecycleLockHandle.writeFile(`${JSON.stringify({ schemaVersion: 1, launchId, launcherPid: process.pid })}\n`, "utf8");
    await lifecycleLockHandle.sync();
  } catch (error) {
    if (lifecycleLockHandle) {
      await lifecycleLockHandle.close().catch(() => undefined);
      lifecycleLockHandle = undefined;
      await rm(paths.lifecycleLock, { force: true });
      throw error;
    }
    if (error.code !== "EEXIST") throw error;
    const owner = await readOptionalJson(paths.lifecycleLock).catch(() => undefined);
    const status = pidAlive(owner?.launcherPid) ? "running" : "stale";
    throw new Error(`OpenViking launcher lock is ${status}: ${paths.lifecycleLock}`);
  }
}

async function releaseLifecycleLock() {
  if (!lifecycleLockHandle) return;
  await lifecycleLockHandle.close();
  lifecycleLockHandle = undefined;
  const owner = await readOptionalJson(paths.lifecycleLock);
  if (!owner) return;
  if (owner.launchId !== launchId) throw new Error("OpenViking launcher lock ownership changed during execution");
  await rm(paths.lifecycleLock, { force: true });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function portIsOpen(host, port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolvePort(open);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function serverAddress(config) {
  const server = config.server;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("OpenViking configuration requires a server section");
  }
  const host = server.host;
  const port = server.port;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("The project launcher only manages a loopback OpenViking server");
  }
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OpenViking server.port must be an integer between 1 and 65535");
  }
  return { host, port };
}

async function publishState(update) {
  const state = {
    schemaVersion: 1,
    launchId,
    launcherPid: process.pid,
    ...update,
  };
  currentState = state;
  const write = stateWriteQueue.then(() => atomicWriteJson(paths.state, state));
  stateWriteQueue = write.catch(() => undefined);
  await write;
  return state;
}

async function baseCandidate(configurationError) {
  const config = JSON.parse(await readFile(paths.baseConfig, "utf8"));
  return {
    config,
    configFingerprint: stableHash(config),
    provider: undefined,
    model: undefined,
    settingsFingerprint: undefined,
    configurationError,
  };
}

async function prepareCandidate() {
  const setting = await readMemoryModelSetting(root);
  if (!setting) return baseCandidate(undefined);
  try {
    if (setting.provider === "litellm"
      && setting.model.toLowerCase().startsWith("openrouter/")
      && !process.env[MEMORY_MODEL_CREDENTIAL_ENV]?.trim()) {
      throw new Error(`${MEMORY_MODEL_CREDENTIAL_ENV} is required for LiteLLM OpenRouter models`);
    }
    return await compileOpenVikingConfig(root, setting);
  } catch (error) {
    throw new MemoryModelConfigurationError(
      paths.settings,
      `memoryModel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function waitForExit(target, timeoutMs) {
  if (target.exitCode !== null || target.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    target.once("exit", onExit);
  });
}

async function stopOwnedChild() {
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    child = undefined;
    ownedAddress = undefined;
    return;
  }
  intentionalStops.add(target);
  target.kill("SIGTERM");
  let exited = await waitForExit(target, stopTimeoutMs);
  if (!exited) {
    target.kill("SIGKILL");
    exited = await waitForExit(target, stopTimeoutMs);
  }
  if (!exited) throw new Error(`Owned OpenViking process ${target.pid ?? "unknown"} did not exit`);
  if (child === target) child = undefined;
  ownedAddress = undefined;
}

function spawnServer(configPath) {
  const target = spawn(serverExecutable, ["--config", configPath], {
    cwd: root,
    env: process.env,
    stdio: process.env.PCR_OPENVIKING_CHILD_STDIO === "ignore" ? "ignore" : "inherit",
    shell: false,
  });
  child = target;
  target.once("error", (error) => {
    target.openVikingSpawnError = error;
    if (child === target && !intentionalStops.has(target)) {
      void publishState({
        ...currentState,
        phase: "failed",
        ready: false,
        childPid: undefined,
        activeProvider: undefined,
        activeModel: undefined,
        activeSettingsFingerprint: undefined,
        activeConfigFingerprint: undefined,
        error: `OpenViking failed to start: ${error.message}`,
      }).catch((publishError) => console.error(`Cannot publish OpenViking failure: ${publishError.message}`));
    }
  });
  target.once("exit", (code, signal) => {
    if (child !== target) return;
    child = undefined;
    ownedAddress = undefined;
    if (intentionalStops.has(target) || shuttingDown) return;
    void publishState({
      ...currentState,
      phase: "failed",
      ready: false,
      childPid: undefined,
      activeProvider: undefined,
      activeModel: undefined,
      activeSettingsFingerprint: undefined,
      activeConfigFingerprint: undefined,
      error: `OpenViking exited before shutdown (${code ?? signal ?? "unknown"})`,
    }).catch((publishError) => console.error(`Cannot publish OpenViking exit: ${publishError.message}`));
  });
  return target;
}

async function waitUntilReady(target, address) {
  const deadline = Date.now() + readinessTimeoutMs;
  const readinessHost = address.host.includes(":") ? `[${address.host}]` : address.host;
  const readinessUrl = `http://${readinessHost}:${address.port}/health`;
  while (Date.now() < deadline) {
    if (target.openVikingSpawnError) throw new Error(`OpenViking failed to start: ${target.openVikingSpawnError.message}`);
    if (target.exitCode !== null || target.signalCode !== null) {
      throw new Error(`OpenViking exited before readiness (${target.exitCode ?? target.signalCode ?? "unknown"})`);
    }
    try {
      const response = await fetch(readinessUrl, {
        signal: AbortSignal.timeout(500),
      });
      const body = await response.json();
      if (response.ok && body?.healthy === true) return;
    } catch {
      // Readiness is retried until the bounded deadline.
    }
    await delay(100);
  }
  throw new Error(`OpenViking readiness timed out after ${readinessTimeoutMs}ms`);
}

async function applyCandidate(candidate, initial, operationId) {
  let address;
  try {
    address = serverAddress(candidate.config);
    if (initial) {
      if (await portIsOpen(address.host, address.port)) {
        throw new Error(`OpenViking port ${address.host}:${address.port} is occupied by an unowned process`);
      }
    } else if (child) {
      if (!ownedAddress) throw new Error("Owned OpenViking process address is unavailable");
      const targetChanged = ownedAddress.host !== address.host || ownedAddress.port !== address.port;
      if (targetChanged && await portIsOpen(address.host, address.port)) {
        throw new Error(`OpenViking target port ${address.host}:${address.port} is occupied by an unowned process`);
      }
    } else if (await portIsOpen(address.host, address.port)) {
      throw new Error(`OpenViking port ${address.host}:${address.port} is occupied by an unowned process`);
    }

    await atomicWriteJson(paths.generatedConfig, candidate.config);
    await publishState({
      ...currentState,
      phase: initial ? "starting" : "restarting",
      ready: Boolean(!initial && child && currentState?.ready),
      childPid: child?.pid,
      operationId,
      targetProvider: candidate.provider,
      targetModel: candidate.model,
      targetSettingsFingerprint: candidate.settingsFingerprint,
      targetConfigFingerprint: candidate.configFingerprint,
      configurationError: candidate.configurationError,
      error: undefined,
    });
  } catch (error) {
    if (!initial) throw new PreflightError(error instanceof Error ? error.message : String(error));
    throw error;
  }

  if (!initial) {
    await stopOwnedChild();
    await publishState({
      ...currentState,
      phase: "restarting",
      ready: false,
      childPid: undefined,
      activeProvider: undefined,
      activeModel: undefined,
      activeSettingsFingerprint: undefined,
      activeConfigFingerprint: undefined,
    });
    if (await portIsOpen(address.host, address.port)) {
      throw new Error(`OpenViking port ${address.host}:${address.port} remained occupied after owned instance stopped`);
    }
  }

  const started = spawnServer(paths.generatedConfig);
  ownedAddress = address;
  await publishState({
    ...currentState,
    phase: initial ? "starting" : "restarting",
    ready: false,
    childPid: started.pid,
  });
  try {
    await waitUntilReady(started, address);
  } catch (error) {
    await stopOwnedChild();
    throw error;
  }
  if (child !== started || started.exitCode !== null || started.signalCode !== null) {
    throw new Error(`OpenViking exited after readiness (${started.exitCode ?? started.signalCode ?? "unknown"})`);
  }
  return publishState({
    ...currentState,
    phase: "ready",
    ready: true,
    childPid: started.pid,
    activeProvider: candidate.provider,
    activeModel: candidate.model,
    activeSettingsFingerprint: candidate.settingsFingerprint,
    activeConfigFingerprint: candidate.configFingerprint,
    error: undefined,
  });
}

async function applyCurrentSetting(initial = false, operationId) {
  let candidate;
  try {
    candidate = await prepareCandidate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!initial) throw new PreflightError(message);
    console.error(`Memory model configuration ignored during cold start: ${message}`);
    candidate = await baseCandidate(message);
  }
  return await applyCandidate(candidate, initial, operationId);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readRequestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error("Control request is too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const controlServer = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/restart") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  let body;
  try {
    body = await readRequestJson(request);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (body?.launchId !== launchId) {
    sendJson(response, 403, { error: "OpenViking launcher ownership mismatch" });
    return;
  }
  if (typeof body.operationId !== "string" || body.operationId.length < 1 || body.operationId.length > 128) {
    sendJson(response, 400, { error: "OpenViking restart operation ID is invalid" });
    return;
  }
  if (currentOperation) {
    sendJson(response, 409, { error: "OpenViking configuration is already being applied", state: currentState });
    return;
  }

  currentOperation = applyCurrentSetting(false, body.operationId);
  try {
    const state = await currentOperation;
    sendJson(response, 200, { state });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PreflightError) {
      sendJson(response, 400, { error: message, state: currentState });
      return;
    }
    const state = await publishState({
      ...currentState,
      phase: "failed",
      ready: false,
      childPid: child?.pid,
      error: message,
    });
    sendJson(response, 500, { error: message, state });
  } finally {
    currentOperation = undefined;
  }
});

async function removeOwnedLauncherInfo() {
  const info = await readOptionalJson(paths.launcherInfo).catch(() => undefined);
  if (info?.launchId === launchId) await rm(paths.launcherInfo, { force: true });
}

async function performShutdown(signal) {
  shuttingDown = true;
  try {
    controlServer.close();
    await currentOperation?.catch(() => undefined);
    await stopOwnedChild();
    await publishState({
      ...currentState,
      phase: "stopped",
      ready: false,
      childPid: undefined,
      activeProvider: undefined,
      activeModel: undefined,
      activeSettingsFingerprint: undefined,
      activeConfigFingerprint: undefined,
      error: signal,
    });
    await removeOwnedLauncherInfo();
    await releaseLifecycleLock();
  } catch (error) {
    shuttingDown = false;
    const ownedStillReady = Boolean(child && currentState?.ready);
    await publishState({
      ...currentState,
      phase: ownedStillReady ? "ready" : "failed",
      ready: ownedStillReady,
      childPid: child?.pid,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

function shutdown(signal) {
  if (!shutdownPromise) {
    shutdownPromise = performShutdown(signal).catch((error) => {
      shutdownPromise = undefined;
      throw error;
    });
  }
  return shutdownPromise;
}

async function main() {
  if (!existsSync(serverExecutable)) {
    throw new Error("Project dependencies are missing. Run: node scripts/install-dependencies.mjs");
  }
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runtimeDir, 0o700);
  await acquireLifecycleLock();
  const existing = await readOptionalJson(paths.launcherInfo);
  if (existing?.launcherPid && pidAlive(existing.launcherPid)) {
    throw new Error(`OpenViking launcher is already running with PID ${existing.launcherPid}`);
  }
  await rm(paths.launcherInfo, { force: true });

  await new Promise((resolveListen, rejectListen) => {
    controlServer.once("error", rejectListen);
    controlServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = controlServer.address();
  if (!address || typeof address === "string") throw new Error("OpenViking launcher did not obtain a control port");
  await atomicWriteJson(paths.launcherInfo, {
    schemaVersion: 1,
    launchId,
    launcherPid: process.pid,
    controlUrl: `http://127.0.0.1:${address.port}`,
    operationTimeoutMs,
  });

  currentOperation = applyCurrentSetting(true);
  try {
    const state = await currentOperation;
    console.log(`OpenViking ready on PID ${state.childPid ?? "unknown"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await publishState({
      ...currentState,
      phase: "failed",
      ready: false,
      childPid: child?.pid,
      error: message,
    });
    console.error(`OpenViking failed to become ready: ${message}`);
  } finally {
    currentOperation = undefined;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void shutdown(signal).then(
      () => process.exit(),
      (error) => console.error(`OpenViking shutdown failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  });
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await stopOwnedChild().catch(() => undefined);
  if (controlServer.listening) await new Promise((resolveClose) => controlServer.close(resolveClose));
  await removeOwnedLauncherInfo().catch((cleanupError) => console.error(`Cannot remove OpenViking launcher info: ${cleanupError.message}`));
  await releaseLifecycleLock().catch((cleanupError) => console.error(`Cannot release OpenViking launcher lock: ${cleanupError.message}`));
  process.exitCode = 1;
});
