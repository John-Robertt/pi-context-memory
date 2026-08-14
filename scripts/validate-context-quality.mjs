#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
} from "./validation-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-context-quality.mjs");

const runId = process.env.PCR_RUN_ID ?? `context-quality-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/context-quality", runId);
const fixturePath = join(root, "validation/fixtures/context-enhancement-long-task.json");
const evidencePath = join(root, "validation/evidence/context-quality.json");
const taskModel = process.env.PCR_QUALITY_MODEL?.trim() || "openai-codex/gpt-5.4";
const memoryModel = process.env.PCR_QUALITY_MEMORY_MODEL?.trim() || taskModel;
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const implementation = captureImplementationEvidence(root, "context-quality");
const startedAt = new Date().toISOString();
mkdirSync(artifactRoot, { recursive: true });
const piVersion = commandOutput("pi", ["--version"]);
const openVikingVersion = commandOutput(join(root, ".venv/bin/python"), ["-c", "import openviking; print(openviking.__version__)"]);
if (piVersion !== "0.84.1" || openVikingVersion !== "0.4.13") {
  throw new Error(`Quality validation requires Pi 0.84.1 and OpenViking 0.4.13 (found ${piVersion}/${openVikingVersion})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function replaceJson(path, value) {
  const pending = `${path}.pending`;
  writeJson(pending, value);
  renameSync(pending, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}
function parseModel(value, label) {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`${label} must use provider/model format`);
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function waitForExit(child, timeoutMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("Child process did not exit")), timeoutMs)),
  ]);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a local port");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeFixtureEntry(entry, model) {
  const normalized = structuredClone(entry);
  if (normalized.type !== "message" || normalized.message?.role !== "assistant") return normalized;
  normalized.message.api = "openai-responses";
  normalized.message.provider = model.provider;
  normalized.message.model = model.model;
  normalized.message.usage = zeroUsage();
  normalized.message.stopReason = normalized.message.content?.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  return normalized;
}

function seedSession(path, model) {
  const entries = fixture.routes.afterCompaction.map((id) => normalizeFixtureEntry(fixture.entries[id], model));
  const evidenceEntry = entries.find((entry) => entry.id === fixture.task.checker.requiredEvidenceEntryId);
  assert(evidenceEntry?.type === "message" && evidenceEntry.message?.role === "toolResult", "Quality fixture evidence entry is invalid");
  evidenceEntry.message.content[0].text += `\n${"受控长历史内容；不得改变当前决定。".repeat(2_000)}`;

  let parentId = entries.at(-1).id;
  let timestamp = Date.parse(entries.at(-1).timestamp) + 1_000;
  for (let index = 0; index < 10; index += 1) {
    const userId = (0xd0000000 + index * 2 + 1).toString(16);
    const assistantId = (0xd0000000 + index * 2 + 2).toString(16);
    entries.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "user", content: `后续中性进度记录 ${index + 1}。`, timestamp },
    });
    timestamp += 1_000;
    entries.push({
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `已记录中性进度 ${index + 1}。` }],
        api: "openai-responses",
        provider: model.provider,
        model: model.model,
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp,
      },
    });
    timestamp += 1_000;
    parentId = assistantId;
  }

  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date(Date.parse(entries[0].timestamp) - 1_000).toISOString(),
    cwd: root,
  };
  writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

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
          this.pending.get(event.id)(event);
          this.pending.delete(event.id);
        }
      }
    });
  }

  send(type, fields = {}) {
    const id = `${type}-${randomUUID()}`;
    return new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`RPC ${type} timed out`));
      }, 180_000);
      this.pending.set(id, (response) => {
        clearTimeout(timeout);
        if (!response.success) rejectResponse(new Error(response.error ?? `RPC ${type} failed`));
        else resolveResponse(response);
      });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  async waitForEvent(predicate, label, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.events.find(predicate);
      if (match) return match;
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Pi exited while waiting for ${label}`);
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    await waitForExit(this.child);
  }
}

function readObservations(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8").trim();
  return content ? content.split("\n").map((line) => JSON.parse(line)) : [];
}

function checker(text) {
  const requiredDecision = fixture.task.checker.requiredDecision;
  const requiredEvidence = fixture.task.checker.requiredEvidenceEntryId;
  const forbiddenDecision = fixture.task.checker.forbiddenDecision;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return {
    validJson: Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed),
    requiredDecision: parsed?.decision === requiredDecision,
    requiredEvidence: parsed?.evidence_entry_id === requiredEvidence,
    forbiddenDecisionExcluded: parsed?.decision !== forbiddenDecision && !text.includes(forbiddenDecision),
  };
}

async function runArm(name, model, openViking) {
  const armRoot = join(artifactRoot, name);
  const sessionPath = join(armRoot, "session.jsonl");
  const observationLog = join(armRoot, "observations.jsonl");
  const conditionLog = join(armRoot, "conditions.jsonl");
  mkdirSync(armRoot, { recursive: true });
  seedSession(sessionPath, model);

  const args = [
    "--mode", "rpc",
    "--session", sessionPath,
    "--model", `${model.provider}/${model.model}`,
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-tools",
  ];
  if (name === "enhanced") args.push("--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"));
  args.push("--extension", openViking.observerPath);

  const stderr = [];
  const child = spawn("pi", args, {
    cwd: root,
    env: {
      ...process.env,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_MEMORY_MODEL_SETTINGS: openViking.settingsPath,
      PCR_OPENVIKING_RUNTIME_DIR: openViking.runtimeDir,
      PCR_OPENVIKING_BASE_CONFIG: openViking.baseConfigPath,
      PCR_OPENVIKING_URL: openViking.url,
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: join(armRoot, "archive"),
      PCR_QUALITY_ARM_OBSERVATION: conditionLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new RpcClient(child);
  try {
    const state = (await client.send("get_state")).data;
    if (name === "enhanced") {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const observations = readObservations(observationLog);
        const ready = observations.find((event) => event.type === "working_context_ready" && event.hasWorkingMemory === true);
        if (ready) break;
        const failed = observations.find((event) => event.type === "working_context_error");
        if (failed) throw new Error(`Working Memory preparation failed: ${failed.error}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Enhanced Pi exited before Working Memory became ready");
        await sleep(200);
      }
      assert(readObservations(observationLog).some((event) => event.type === "working_context_ready" && event.hasWorkingMemory === true), "Real Working Memory did not become ready");
    }

    const settledBefore = client.events.filter((event) => event.type === "agent_settled").length;
    await client.send("prompt", {
      message: "只依据当前有效路线回答。若有效方案只采用当前路线的有界上下文，decision 输出 bounded-current-route；若采用路线 A 的完整历史，输出 full-history-route-a。evidence_entry_id 输出支撑当前方案的工具证据入口。只输出包含这两个字段的 JSON。",
    });
    await client.waitForEvent(
      (_event, index) => client.events.slice(0, index + 1).filter((event) => event.type === "agent_settled").length > settledBefore,
      `${name} agent settlement`,
    );
    const response = await client.send("get_last_assistant_text");
    const stats = await client.send("get_session_stats");
    const { sessionFile: _sessionFile, sessionId: _sessionId, ...qualityStats } = stats.data;
    const text = response.data.text ?? "";
    const observations = readObservations(observationLog);
    const adopted = name === "native" || observations.some((event) => event.type === "before_provider_request" && event.contextPath === "enhanced");
    const condition = readObservations(conditionLog).at(-1);
    return {
      text,
      textSha256: sha256(text),
      checker: checker(text),
      adopted,
      model: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
      condition,
      stats: qualityStats,
      observations: {
        workingContextReady: observations.filter((event) => event.type === "working_context_ready").length,
        enhancedProviderRequests: observations.filter((event) => event.type === "before_provider_request" && event.contextPath === "enhanced").length,
      },
    };
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`);
  } finally {
    writeJson(join(armRoot, "rpc-events.json"), client.events);
    writeFileSync(join(armRoot, "pi-stderr.log"), Buffer.concat(stderr));
    await client.close();
  }
}

const task = parseModel(taskModel, "PCR_QUALITY_MODEL");
const memory = parseModel(memoryModel, "PCR_QUALITY_MEMORY_MODEL");
const runtimeDir = join(artifactRoot, "openviking-runtime");
const settingsPath = join(artifactRoot, "memory-model.jsonc");
const baseConfigPath = join(artifactRoot, "openviking-base.json");
const observerPath = join(artifactRoot, "quality-observer.ts");
const baseConfig = JSON.parse(readFileSync(join(root, "config/openviking.json"), "utf8"));
const port = await freePort();
baseConfig.server.host = "127.0.0.1";
baseConfig.server.port = port;
writeJson(baseConfigPath, baseConfig);
writeJson(settingsPath, { memoryModel: memory });
writeFileSync(observerPath, [
  "import { createHash } from \"node:crypto\";",
  "import { appendFileSync } from \"node:fs\";",
  "export default function qualityObserver(pi) {",
  "  pi.on(\"session_start\", () => pi.setActiveTools([]));",
  "  pi.on(\"before_agent_start\", (event, ctx) => {",
  "    const record = {",
  "      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,",
  "      modelHash: createHash(\"sha256\").update(JSON.stringify(ctx.model ?? null)).digest(\"hex\"),",
  "      thinking: ctx.thinkingLevel,",
  "      activeTools: pi.getActiveTools().slice().sort(),",
  "      systemPromptHash: createHash(\"sha256\").update(event.systemPrompt).digest(\"hex\"),",
  "    };",
  "    appendFileSync(process.env.PCR_QUALITY_ARM_OBSERVATION, `${JSON.stringify(record)}\\n`, \"utf8\");",
  "  });",
  "}",
  "",
].join("\n"), "utf8");

const launcherStdout = [];
const launcherStderr = [];
const launcher = spawn("node", [join(root, "scripts/start-openviking.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    PCR_MEMORY_MODEL_SETTINGS: settingsPath,
    PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
    PCR_OPENVIKING_BASE_CONFIG: baseConfigPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
launcher.stdout.on("data", (chunk) => launcherStdout.push(Buffer.from(chunk)));
launcher.stderr.on("data", (chunk) => launcherStderr.push(Buffer.from(chunk)));

let result;
try {
  const statePath = join(runtimeDir, "state.json");
  const deadline = Date.now() + 180_000;
  let runtimeState;
  while (Date.now() < deadline) {
    if (existsSync(statePath)) {
      runtimeState = JSON.parse(readFileSync(statePath, "utf8"));
      if (runtimeState.ready === true) break;
      if (runtimeState.phase === "failed" || runtimeState.phase === "stopped") throw new Error(runtimeState.error ?? `OpenViking entered ${runtimeState.phase}`);
    }
    if (launcher.exitCode !== null || launcher.signalCode !== null) throw new Error("OpenViking launcher exited before readiness");
    await sleep(200);
  }
  assert(runtimeState?.ready === true, "Timed out waiting for real OpenViking readiness");
  const openViking = { url: `http://127.0.0.1:${port}`, runtimeDir, settingsPath, baseConfigPath, observerPath };
  const native = await runArm("native", task, openViking);
  const enhanced = await runArm("enhanced", task, openViking);
  const nativePassed = Object.values(native.checker).every(Boolean);
  const enhancedPassed = Object.values(enhanced.checker).every(Boolean);
  const checks = {
    nativeQuality: nativePassed,
    enhancedQuality: enhancedPassed,
    enhancedContextAdopted: enhanced.adopted && enhanced.observations.enhancedProviderRequests > 0,
    realWorkingMemoryReady: enhanced.observations.workingContextReady > 0,
    sameTaskModel: native.model === taskModel && enhanced.model === taskModel,
    pairedConditions: Boolean(native.condition)
      && JSON.stringify(native.condition) === JSON.stringify(enhanced.condition),
  };
  const passed = Object.values(checks).every(Boolean);
  result = {
    schemaVersion: 1,
    generatedBy: "scripts/validate-context-quality.mjs",
    scope: "real-provider-quality",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    piVersion,
    openVikingVersion,
    models: { task: taskModel, memory: memoryModel },
    fixture: {
      path: "validation/fixtures/context-enhancement-long-task.json",
      name: fixture.name,
      sha256: sha256(readFileSync(fixturePath)),
    },
    execution: { order: ["native", "enhanced"], repetitions: 1 },
    implementation,
    passed,
    checks,
    arms: { native, enhanced },
    limitations: [
      "This experiment establishes paired task quality with one fixed fixture and does not establish general quality equivalence.",
      "API cost comparison remains a separate stage and must include all task and memory requests.",
    ],
  };
  assertImplementationEvidenceUnchanged(root, "context-quality", implementation);
  replaceJson(evidencePath, result);
  writeJson(join(artifactRoot, "result.json"), result);
  console.log(`current evidence: ${evidencePath}`);
  console.log(`raw evidence: ${artifactRoot}`);
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  result = {
    schemaVersion: 1,
    generatedBy: "scripts/validate-context-quality.mjs",
    scope: "real-provider-quality",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  };
  writeJson(join(artifactRoot, "result.json"), result);
  throw error;
} finally {
  writeFileSync(join(artifactRoot, "launcher-stdout.log"), Buffer.concat(launcherStdout));
  writeFileSync(join(artifactRoot, "launcher-stderr.log"), Buffer.concat(launcherStderr));
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
  await waitForExit(launcher).catch(() => undefined);
}
