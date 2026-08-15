#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  memoryModelConfigPath,
  readMemoryModelSetting,
  readRuntimeState,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import { assertValidationPiVersion, readValidationModels } from "./validation-suite.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-real-context-adoption.mjs");
const piVersion = assertValidationPiVersion(root);
const { task: taskModel, memory: expectedMemoryModel } = readValidationModels(root);
const interTurnDelayMs = Number.parseInt(process.env.PCR_REAL_ADOPTION_INTER_TURN_DELAY_MS ?? "0", 10);
if (!Number.isSafeInteger(interTurnDelayMs) || interTurnDelayMs < 0) {
  throw new Error("PCR_REAL_ADOPTION_INTER_TURN_DELAY_MS must be a non-negative integer");
}
const scenario = process.env.PCR_REAL_ADOPTION_SCENARIO?.trim();
if (scenario !== "skipped" && scenario !== "accepted") {
  throw new Error("PCR_REAL_ADOPTION_SCENARIO must be skipped or accepted");
}
const startupDelayMs = Number.parseInt(
  process.env.PCR_REAL_ADOPTION_STARTUP_DELAY_MS ?? "5000",
  10,
);
if (!Number.isSafeInteger(startupDelayMs) || startupDelayMs < 0) {
  throw new Error("PCR_REAL_ADOPTION_STARTUP_DELAY_MS must be a non-negative integer");
}
const splitModel = (value) => {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid provider/model coordinate: ${value}`);
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
};
const task = splitModel(taskModel);
const expectedMemory = splitModel(expectedMemoryModel);
const settingsPath = memoryModelConfigPath(root, process.env);
if (!existsSync(settingsPath)) throw new Error(`Memory model configuration does not exist: ${settingsPath}`);
const configuredMemory = await readMemoryModelSetting(root, process.env);
const runtime = await readRuntimeState(root, process.env);
if (!configuredMemory
  || configuredMemory.provider !== expectedMemory.provider
  || configuredMemory.model !== expectedMemory.model) {
  throw new Error(`Configured memory model does not match ${expectedMemoryModel}`);
}
if (!runtime?.ready
  || runtime.activeProvider !== expectedMemory.provider
  || runtime.activeModel !== expectedMemory.model
  || runtime.targetProvider !== expectedMemory.provider
  || runtime.targetModel !== expectedMemory.model) {
  throw new Error(`Running memory model does not match ${expectedMemoryModel}`);
}

const runId = process.env.PCR_RUN_ID ?? `real-context-adoption-${scenario}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const runDir = join(root, ".artifacts/real-context-adoption", runId);
const sessionPath = join(runDir, "session.jsonl");
const observationPath = join(runDir, "observation.jsonl");
const rpcPath = join(runDir, "rpc-events.jsonl");
const stderrPath = join(runDir, "pi-stderr.log");
const summaryPath = join(runDir, "summary.json");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

class RpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.buffer = "";
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        this.events.push(event);
        if (event.type === "response" && event.id && this.pending.has(event.id)) {
          const pending = this.pending.get(event.id);
          this.pending.delete(event.id);
          pending.resolve(event);
        }
      }
    });
  }

  async send(type, payload = {}, timeoutMs = 30_000) {
    const id = randomUUID();
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Timed out waiting for RPC ${type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (event) => {
          clearTimeout(timeout);
          if (event.success === false) rejectResponse(new Error(event.error ?? `RPC ${type} failed`));
          else resolveResponse(event);
        },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    return response;
  }

  async waitForSettled(previousCount, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = this.events.filter((event) => event.type === "agent_settled").length;
      if (count > previousCount) return;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error("Pi exited before agent_settled");
      await sleep(50);
    }
    throw new Error("Timed out waiting for agent_settled");
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await sleep(50);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

await mkdir(runDir, { recursive: true });
const header = {
  type: "session",
  version: 3,
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  cwd: root,
};
const seedEntries = [];
if (scenario === "accepted") {
  let parentId = null;
  let timestamp = Date.now() - 20_000;
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (let index = 0; index < 5; index += 1) {
    const userId = (0xe0000001 + index * 2).toString(16);
    const assistantId = (0xe0000002 + index * 2).toString(16);
    seedEntries.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "user",
        content: index === 0 ? `accepted commit seed\n${"真实慢任务历史；".repeat(4_000)}` : `accepted route progress ${index}`,
        timestamp,
      },
    });
    timestamp += 1_000;
    seedEntries.push({
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `accepted route response ${index}` }],
        api: "openai-responses",
        provider: task.provider,
        model: task.model,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp,
      },
    });
    parentId = assistantId;
    timestamp += 1_000;
  }
}
await writeFile(sessionPath, `${[header, ...seedEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

const child = spawn("pi", [
  "--mode", "rpc",
  "--session", sessionPath,
  "--model", taskModel,
  "--thinking", "off",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-extensions",
  "--no-tools",
  "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
], {
  cwd: root,
  env: {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PCR_RUN_ID: runId,
    PCR_OBSERVATION_LOG: observationPath,
    PCR_ARCHIVE_DIR: join(runDir, "archive"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
const client = new RpcClient(child);
let summary;
try {
  const state = (await client.send("get_state")).data;
  if (!existsSync(state.sessionFile)) throw new Error(`Pi session was not persisted: ${state.sessionFile}`);
  await sleep(startupDelayMs);
  const historicalLeafId = (await client.send("get_entries")).data.leafId;

  if (scenario === "skipped") {
    const historicalPayload = "可核验增强采用路径；".repeat(4_000);
    const firstSettled = client.events.filter((event) => event.type === "agent_settled").length;
    await client.send("prompt", { message: `${historicalPayload}\n只回复 FIRST。` });
    await client.waitForSettled(firstSettled);

    await sleep(interTurnDelayMs);
    const secondSettled = client.events.filter((event) => event.type === "agent_settled").length;
    await client.send("prompt", { message: "只回复 SECOND。" });
    await client.waitForSettled(secondSettled);
  } else {
    const settled = client.events.filter((event) => event.type === "agent_settled").length;
    await client.send("prompt", { message: "只回复 ACCEPTED。" });
    await client.waitForSettled(settled);

    const deadline = Date.now() + 190_000;
    let finalized = false;
    while (Date.now() < deadline) {
      const current = existsSync(observationPath)
        ? (await readFile(observationPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      const request = current.find((event) => event.type === "before_provider_request");
      const ready = current.find((event) => event.type === "working_context_ready"
        && event.leafId === historicalLeafId
        && event.hasWorkingMemory === true);
      if (request && ready && ready.sequence > request.sequence) {
        finalized = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Pi exited before accepted Working Memory completed");
      await sleep(200);
    }
    if (!finalized) throw new Error("Accepted Working Memory did not complete after the Provider request");
  }
  await sleep(500);

  const observations = existsSync(observationPath)
    ? (await readFile(observationPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const providerRequests = observations.filter((event) => event.type === "before_provider_request");
  const workingReady = observations.filter((event) => event.type === "working_context_ready");
  const workingErrors = observations.filter((event) => event.type === "working_context_error");
  const firstRequest = providerRequests[0];
  const secondRequest = providerRequests[1];
  const acceptedFinalReady = workingReady.find((event) => event.leafId === historicalLeafId && event.hasWorkingMemory === true);
  const stats = (await client.send("get_session_stats")).data;
  summary = {
    schemaVersion: 1,
    runId,
    piVersion,
    nodeVersion: process.versions.node,
    taskModel,
    memoryModel: expectedMemoryModel,
    scenario,
    startupDelayMs,
    historicalLeafId,
    interTurnDelayMs,
    sessionFile: state.sessionFile,
    providerRequests: providerRequests.map((event) => ({
      sequence: event.sequence,
      at: event.at,
      provider: event.provider,
      model: event.model,
      hookOutcome: event.hookOutcome,
      contextAuthorization: event.contextAuthorization,
      nonce: event.nonce,
      rejectionReason: event.rejectionReason,
      payloadHasEnhancedContext: event.payloadHasEnhancedContext,
      payloadBytes: event.payloadBytes,
      payloadHash: event.payloadHash,
    })),
    workingReady: workingReady.map((event) => ({
      sequence: event.sequence,
      at: event.at,
      trigger: event.trigger,
      hasWorkingMemory: event.hasWorkingMemory,
      leafId: event.leafId,
      routeFingerprint: event.routeFingerprint,
    })),
    workingErrors: workingErrors.map((event) => ({ at: event.at, trigger: event.trigger, error: event.error })),
    usage: { tokens: stats.tokens, cost: stats.cost },
    passed: workingErrors.length === 0 && (scenario === "skipped"
      ? providerRequests.length === 2
        && secondRequest?.hookOutcome === "verified"
        && secondRequest?.contextAuthorization === "allowed"
        && secondRequest?.payloadHasEnhancedContext === true
        && workingReady.some((event) => event.hasWorkingMemory === false)
      : providerRequests.length === 1
        && firstRequest?.hookOutcome === "verified"
        && firstRequest?.contextAuthorization === "allowed"
        && firstRequest?.payloadHasEnhancedContext === true
        && typeof firstRequest.sequence === "number"
        && typeof acceptedFinalReady?.sequence === "number"
        && acceptedFinalReady.sequence > firstRequest.sequence),
  };
} catch (error) {
  summary = {
    schemaVersion: 1,
    runId,
    taskModel,
    memoryModel: expectedMemoryModel,
    scenario,
    startupDelayMs,
    interTurnDelayMs,
    passed: false,
    error: error instanceof Error ? error.stack : String(error),
  };
} finally {
  await stop(child);
  await writeFile(rpcPath, `${client.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(stderrPath, Buffer.concat(stderr));
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

console.log(`raw evidence: ${runDir}`);
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
