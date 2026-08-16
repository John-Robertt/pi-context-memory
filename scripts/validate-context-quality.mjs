#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  COMPILED_OPENVIKING_CREDENTIAL,
  compileOpenVikingConfig,
  OPENVIKING_MEMORY_API_KEY_ENV,
  OPENVIKING_MEMORY_API_KEY_REFERENCE,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import { memoryRuntimeGenerationFromState } from "../.pi/extensions/pi-context-memory/memory-runtime-capability.ts";
import {
  historicalRoutePrefixKey,
  OpenVikingSessionMemory,
} from "../.pi/extensions/pi-context-memory/session-working-memory.ts";
import {
  createProviderPayloadProfile,
  createRetentionBudgetIdentity,
  WorkingContextOptimizer,
} from "../.pi/extensions/pi-context-memory/working-context-optimization.ts";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import {
  assertValidationPiVersion,
  createIsolatedPiProviderCredential,
  readProjectOpenVikingVersion,
  readValidationModels,
  readValidationSuite,
} from "./validation-suite.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALITY_CREDENTIAL_ENV = "PCR_CONTEXT_QUALITY_OPENROUTER_API_KEY";
const QUALITY_AMBIENT_OPENROUTER_SENTINEL = "quality-ambient-openrouter-must-not-reach-child";
const QUALITY_UNRELATED_CREDENTIAL_ENV = "ANTHROPIC_API_KEY";
const QUALITY_UNRELATED_CREDENTIAL_SENTINEL = "quality-unrelated-provider-must-not-reach-child";
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-context-quality.mjs");

const runId = process.env.PCR_RUN_ID ?? `context-quality-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/context-quality", runId);
const fixturePath = join(root, "validation/fixtures/context-enhancement-long-task.json");
const evidencePath = join(root, "validation/evidence/context-quality.json");
const suite = readValidationSuite(root);
if (suite.diagnostics.pairedQualityRepetitions !== 1) {
  throw new Error("The paired quality diagnostic runner currently supports exactly one repetition");
}
const { task: taskModel, memory: memoryModel } = readValidationModels(root);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const implementation = captureImplementationEvidence(root, "context-quality");
const startedAt = new Date().toISOString();
mkdirSync(artifactRoot, { recursive: true });
const piVersion = assertValidationPiVersion(root);
const expectedOpenVikingVersion = readProjectOpenVikingVersion(root);
const pythonCommand = process.platform === "win32"
  ? join(root, ".venv/Scripts/python.exe")
  : join(root, ".venv/bin/python");
const openVikingVersion = commandOutput(pythonCommand, ["-c", "import openviking; print(openviking.__version__)"]);
if (openVikingVersion !== expectedOpenVikingVersion) {
  throw new Error(`Quality validation requires locked OpenViking ${expectedOpenVikingVersion}; found ${openVikingVersion}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function replaceJson(path, value) {
  const pending = `${path}.pending`;
  writeJson(pending, value);
  renameSync(pending, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointRoute(sessionId, sessionFile, projections) {
  const entryIds = projections.map((projection) => projection.id);
  return {
    sessionId,
    sessionFile,
    leafId: entryIds.at(-1) ?? null,
    entryIds,
    fingerprint: sha256(JSON.stringify({ sessionId, sessionFile, projections })),
  };
}

function checkpointSource(id, parentId, index, text) {
  const taskContent = [{ type: "text", text }];
  return {
    kind: "message-source",
    id,
    parentId,
    role: index % 2 === 0 ? "user" : "assistant",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    taskContent,
    completion: index % 2 === 0 ? undefined : { stopReason: "stop" },
    taskContentHash: sha256(JSON.stringify(taskContent)),
    authorityHash: sha256(JSON.stringify({ id, parentId, taskContent })),
  };
}

function activeDelta(checkpoint, projections) {
  return {
    checkpointIdentity: checkpoint.identity,
    projections,
    sourceIds: projections.map((projection) => projection.id),
    hash: sha256(JSON.stringify({ checkpointIdentity: checkpoint.identity, projections })),
  };
}

async function validateActualCheckpointFlow(openViking, runtimeState) {
  const generation = memoryRuntimeGenerationFromState(runtimeState);
  const capabilityProofId = runtimeState?.memoryCapability?.proofId;
  assert(generation && capabilityProofId, "Actual checkpoint validation requires a runtime capability proof");
  const sessionMemory = new OpenVikingSessionMemory(openViking.url, undefined, 30_000, {
    generation,
    capabilityProofId,
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    taskTimeoutMs: runtimeState.activeProfile.requestTimeoutMs,
    taskPollMs: 100,
  });
  try {
    const profile = createProviderPayloadProfile({
      provider: "actual-checkpoint-validation",
      model: "fixed-suite-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1/actual-checkpoint-validation",
      compat: null,
      contextWindowTokens: 32_000,
      maxOutputTokens: 256,
      systemPrompt: "actual checkpoint validation",
      tools: [],
    });
    const retentionBudgetIdentity = createRetentionBudgetIdentity(profile, sessionMemory.retentionPolicy());
    const sessionId = `quality-checkpoint-${randomUUID()}`;
    const sessionFile = join(openViking.runtimeDir, `${sessionId}.jsonl`);
    const projections = Array.from({ length: 8 }, (_, index) => checkpointSource(
      `actual-checkpoint-${index}`,
      index === 0 ? null : `actual-checkpoint-${index - 1}`,
      index,
      `actual checkpoint source ${index}: ${"C".repeat(520)}`,
    ));
    const route = checkpointRoute(sessionId, sessionFile, projections);
    const emptyCheckpoint = sessionMemory.emptyCheckpoint(route, retentionBudgetIdentity);
    const beforeRefresh = {
      route,
      checkpoint: emptyCheckpoint,
      delta: activeDelta(emptyCheckpoint, projections),
      hasOpaqueSegment: false,
    };
    const optimizer = new WorkingContextOptimizer({ maxContextChars: 1_600 });
    const authorizationInput = {
      generation,
      messages: [{ role: "user", content: "continue actual checkpoint validation" }],
      providerPayloadProfile: profile,
      toolSources: { callSources: {}, resultSources: {}, ambiguousToolIds: [] },
      toProviderMessages: (messages) => messages,
      ensureSources: async () => undefined,
    };
    const required = await optimizer.authorize({ ...authorizationInput, requestRoute: route, historical: beforeRefresh });
    assert(required.kind === "refresh-required", "Oversized actual delta did not require a checkpoint refresh");
    const target = {
      generation,
      routePrefixKey: historicalRoutePrefixKey(route, projections),
      watermark: route.entryIds.at(-1) ?? null,
      retentionBudgetIdentity,
    };
    const refreshed = await sessionMemory.refreshCheckpoint(target, route, projections, { required: true });
    assert(refreshed.kind === "accepted", "Actual required checkpoint refresh was not accepted");
    const afterRefresh = {
      route,
      checkpoint: refreshed.checkpoint,
      delta: activeDelta(refreshed.checkpoint, []),
      hasOpaqueSegment: false,
    };
    const afterAuthorization = await optimizer.authorize({ ...authorizationInput, requestRoute: route, historical: afterRefresh });
    assert(afterAuthorization.kind === "allow", "Actual checkpoint did not satisfy the waiting request");

    const nextProjection = checkpointSource("actual-checkpoint-next", route.leafId, 9, `actual active delta: ${"D".repeat(320)}`);
    const nextProjections = [...projections, nextProjection];
    const nextRoute = checkpointRoute(sessionId, sessionFile, nextProjections);
    const nextTarget = {
      generation,
      routePrefixKey: historicalRoutePrefixKey(nextRoute, nextProjections),
      watermark: nextRoute.entryIds.at(-1) ?? null,
      retentionBudgetIdentity,
    };
    let backgroundSettled = false;
    const background = sessionMemory.refreshCheckpoint(nextTarget, nextRoute, nextProjections, { required: false })
      .finally(() => { backgroundSettled = true; });
    const duringRefresh = {
      route: nextRoute,
      checkpoint: refreshed.checkpoint,
      delta: activeDelta(refreshed.checkpoint, [nextProjection]),
      hasOpaqueSegment: false,
    };
    const parallelAuthorization = await new WorkingContextOptimizer({ maxContextChars: 4_000 })
      .authorize({ ...authorizationInput, requestRoute: nextRoute, historical: duringRefresh });
    const requestContinuedBeforeRefresh = parallelAuthorization.kind === "allow" && !backgroundSettled;
    const backgroundResult = await background;
    assert(backgroundResult.kind === "accepted", "Actual background checkpoint refresh was not accepted");
    assert(requestContinuedBeforeRefresh, "A compatible checkpoint and delta did not continue during actual refresh");
    return {
      requiredWait: true,
      requestContinuedBeforeRefresh,
      backgroundAccepted: true,
      firstCheckpointIdentity: refreshed.checkpoint.identity,
      nextCheckpointIdentity: backgroundResult.checkpoint.identity,
    };
  } finally {
    await sessionMemory.shutdown();
  }
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

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
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
function assistantEntryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
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
    "--thinking", suite.models.taskThinking,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-tools",
  ];
  if (name === "enhanced") args.push("--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"));
  args.push("--extension", openViking.observerPath);

  const stderr = [];
  const piEnvironment = {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PCR_MEMORY_MODEL_SETTINGS: openViking.settingsPath,
    PCR_OPENVIKING_RUNTIME_DIR: openViking.runtimeDir,
    PCR_OPENVIKING_BASE_CONFIG: openViking.baseConfigPath,
    PCR_OPENVIKING_URL: openViking.url,
    PCR_CHECKPOINT_COMMIT_PENDING_TOKENS: "1",
    PCR_OBSERVATION_LOG: observationLog,
    PCR_ARCHIVE_DIR: join(armRoot, "archive"),
    PCR_QUALITY_ARM_OBSERVATION: conditionLog,
  };
  delete piEnvironment[QUALITY_CREDENTIAL_ENV];
  delete piEnvironment[OPENVIKING_MEMORY_API_KEY_ENV];
  delete piEnvironment[QUALITY_UNRELATED_CREDENTIAL_ENV];
  delete piEnvironment.OPENROUTER_API_KEY;
  const child = spawn("pi", args, {
    cwd: root,
    env: piEnvironment,
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
        const ready = observations.find((event) => event.type === "checkpoint_refresh_complete"
          && event.outcome === "accepted"
          && event.hasWorkingMemory === true);
        if (ready) break;
        const failed = observations.find((event) => event.type === "checkpoint_refresh_error");
        if (failed) throw new Error(`Working Memory preparation failed: ${failed.error}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("Enhanced Pi exited before Working Memory became ready");
        await sleep(200);
      }
      assert(readObservations(observationLog).some((event) => event.type === "checkpoint_refresh_complete"
        && event.outcome === "accepted"
        && event.hasWorkingMemory === true), "Real Working Memory checkpoint did not become ready");
    }

    const settledBefore = client.events.filter((event) => event.type === "agent_settled").length;
    const sessionEntryIdsBefore = new Set(readObservations(sessionPath).map((entry) => entry.id).filter(Boolean));
    await client.send("prompt", {
      message: "只依据当前有效路线回答。若有效方案只采用当前路线的有界上下文，decision 输出 bounded-current-route；若采用路线 A 的完整历史，输出 full-history-route-a。evidence_entry_id 输出支撑当前方案的工具证据入口。只输出包含这两个字段的 JSON。",
    });
    await client.waitForEvent(
      (_event, index) => client.events.slice(0, index + 1).filter((event) => event.type === "agent_settled").length > settledBefore,
      `${name} agent settlement`,
    );
    const requestEntries = readObservations(sessionPath).filter((entry) => !sessionEntryIdsBefore.has(entry.id));
    const assistantEntry = [...requestEntries].reverse().find((entry) =>
      entry.type === "message" && entry.message?.role === "assistant");
    assert(assistantEntry, `${name} request did not persist an assistant result`);
    const stats = await client.send("get_session_stats");
    const { sessionFile: _sessionFile, sessionId: _sessionId, ...qualityStats } = stats.data;
    const text = assistantEntryText(assistantEntry);
    const requestResult = {
      entryId: assistantEntry.id,
      stopReason: assistantEntry.message.stopReason,
      usage: assistantEntry.message.usage,
    };
    const observations = readObservations(observationLog);
    const hookVerified = name === "enhanced"
      ? observations.some((event) => event.type === "before_provider_request"
        && event.hookOutcome === "verified"
        && event.contextAuthorization === "allowed")
      : null;
    const condition = readObservations(conditionLog).at(-1);
    return {
      text,
      textSha256: sha256(text),
      checker: checker(text),
      hookVerified,
      model: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
      condition,
      stats: qualityStats,
      requestResult,
      observations: {
        workingContextReady: observations.filter((event) => event.type === "checkpoint_refresh_complete"
          && event.outcome === "accepted"
          && event.hasWorkingMemory === true).length,
        hookVerifiedRequests: observations.filter((event) => event.type === "before_provider_request" && event.hookOutcome === "verified").length,
      },
    };
  } catch (error) {
    throw new Error(redactQualityCredential(
      `${name}: ${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`,
    ));
  } finally {
    writeFileSync(
      join(armRoot, "rpc-events.json"),
      `${redactQualityCredential(JSON.stringify(client.events, null, 2))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(armRoot, "pi-stderr.log"),
      redactQualityCredential(Buffer.concat(stderr).toString("utf8")),
      { encoding: "utf8", mode: 0o600 },
    );
    await client.close();
  }
}

const task = parseModel(taskModel, "task model");
const inheritedQualityCredential = process.env[QUALITY_CREDENTIAL_ENV];
const isolatedOpenRouterCredential = createIsolatedPiProviderCredential(
  "openrouter",
  QUALITY_CREDENTIAL_ENV,
  { cwd: root },
);
const qualityEnvironment = {
  ...process.env,
  ...isolatedOpenRouterCredential.environment,
  OPENROUTER_API_KEY: QUALITY_AMBIENT_OPENROUTER_SENTINEL,
  [QUALITY_UNRELATED_CREDENTIAL_ENV]: QUALITY_UNRELATED_CREDENTIAL_SENTINEL,
};
const isolatedOpenRouterApiKey = isolatedOpenRouterCredential.environment[QUALITY_CREDENTIAL_ENV];
const redactQualityCredential = (value) => String(value).replaceAll(isolatedOpenRouterApiKey, "<redacted>");
const memory = {
  ...parseModel(memoryModel, "memory model"),
  api_key: isolatedOpenRouterCredential.reference,
};
const adapterProbe = JSON.parse(commandOutput(
  pythonCommand,
  [join(root, "scripts/validate-openviking-vlm-adapters.py"), memory.model],
));
const memoryRequestSemantics = memory.provider === suite.models.memoryProvider
  && memory.model === suite.models.memoryRoute
  && adapterProbe.passed === true
  ? {
    adapter: "LiteLLM OpenRouter",
    model: adapterProbe.litellmOpenRouterRequest?.model,
    apiKeyForwarded: adapterProbe.litellmOpenRouterRequest?.apiKeyForwarded,
    reasoningForwarded: adapterProbe.litellmOpenRouterRequest?.reasoningForwarded,
    temperatureForwarded: adapterProbe.litellmOpenRouterRequest?.temperatureForwarded,
    temperature: adapterProbe.litellmOpenRouterRequest?.temperature,
    timeoutForwarded: adapterProbe.litellmOpenRouterRequest?.timeoutForwarded,
  }
  : undefined;
const runtimeDir = join(artifactRoot, "openviking-runtime");
const settingsPath = join(artifactRoot, "memory-model.jsonc");
const baseConfigPath = join(artifactRoot, "openviking-base.json");
const observerPath = join(artifactRoot, "quality-observer.ts");
const openVikingEnvironmentReportPath = join(artifactRoot, "openviking-child-environment.json");
const openVikingWrapperPath = join(artifactRoot, "openviking-server-wrapper.mjs");
const realOpenVikingServer = process.platform === "win32"
  ? join(root, ".venv/Scripts/openviking-server.exe")
  : join(root, ".venv/bin/openviking-server");
const baseConfig = JSON.parse(readFileSync(join(root, "config/openviking.json"), "utf8"));
const port = await freePort();
baseConfig.server.host = "127.0.0.1";
baseConfig.server.port = port;
baseConfig.storage.workspace = join(artifactRoot, "openviking-data");
writeJson(baseConfigPath, baseConfig);
await atomicWriteJson(settingsPath, { memoryModel: memory });
const compiledMemoryModel = await compileOpenVikingConfig(root, memory, {
  ...qualityEnvironment,
  PCR_MEMORY_MODEL_SETTINGS: settingsPath,
  PCR_OPENVIKING_BASE_CONFIG: baseConfigPath,
});
const explicitMemoryRequestControls = ["thinking", "temperature", "max_retries", "stream"]
  .filter((field) => Object.hasOwn(compiledMemoryModel.config.vlm, field));
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
  `      credentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(QUALITY_CREDENTIAL_ENV)}),`,
  `      internalCredentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}),`,
  `      unrelatedCredentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(QUALITY_UNRELATED_CREDENTIAL_ENV)}),`,
  "      ambientOpenRouterCredentialPresent: Object.hasOwn(process.env, \"OPENROUTER_API_KEY\"),",
  "      systemPromptHash: createHash(\"sha256\").update(event.systemPrompt).digest(\"hex\"),",
  "    };",
  "    appendFileSync(process.env.PCR_QUALITY_ARM_OBSERVATION, `${JSON.stringify(record)}\\n`, \"utf8\");",
  "  });",
  "}",
  "",
].join("\n"), "utf8");

writeFileSync(openVikingWrapperPath, [
  `#!${process.execPath}`,
  "import { spawn } from \"node:child_process\";",
  "import { writeFileSync } from \"node:fs\";",
  `const child = spawn(${JSON.stringify(realOpenVikingServer)}, process.argv.slice(2), { env: process.env, stdio: "inherit", shell: false });`,
  `writeFileSync(${JSON.stringify(openVikingEnvironmentReportPath)}, JSON.stringify({ childPid: child.pid, credentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(QUALITY_CREDENTIAL_ENV)}), internalCredentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}), ambientOpenRouterCredentialPresent: Object.hasOwn(process.env, "OPENROUTER_API_KEY"), unrelatedCredentialEnvironmentPresent: Object.hasOwn(process.env, ${JSON.stringify(QUALITY_UNRELATED_CREDENTIAL_ENV)}) }));`,
  "let stopping = false;",
  "let stopTimer;",
  "function stop(signal) {",
  "  if (stopping) return;",
  "  stopping = true;",
  "  if (child.exitCode === null && child.signalCode === null) child.kill(signal);",
  "  stopTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(\"SIGKILL\"); }, 2000);",
  "  stopTimer.unref();",
  "}",
  "for (const signal of [\"SIGINT\", \"SIGTERM\", \"SIGHUP\"]) process.on(signal, () => stop(signal));",
  "child.on(\"error\", (error) => { console.error(error); process.exitCode = 1; });",
  "child.on(\"exit\", (code, signal) => { clearTimeout(stopTimer); process.exit(code ?? (signal ? 1 : 0)); });",
  "",
].join("\n"), { encoding: "utf8", mode: 0o700 });


const launcherStdout = [];
const launcherStderr = [];
const launcher = spawn("node", [join(root, "scripts/start-openviking.mjs")], {
  cwd: root,
  env: {
    ...qualityEnvironment,
    PCR_MEMORY_MODEL_SETTINGS: settingsPath,
    PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
    PCR_OPENVIKING_BASE_CONFIG: baseConfigPath,
    PCR_OPENVIKING_SERVER: openVikingWrapperPath,
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
  assert(existsSync(openVikingEnvironmentReportPath), "Real OpenViking child environment was not observed");
  const openVikingChildEnvironment = JSON.parse(readFileSync(openVikingEnvironmentReportPath, "utf8"));
  const openViking = { url: `http://127.0.0.1:${port}`, runtimeDir, settingsPath, baseConfigPath, observerPath };
  const actualCheckpointFlow = await validateActualCheckpointFlow(openViking, runtimeState);
  const native = await runArm("native", task, openViking);
  const enhanced = await runArm("enhanced", task, openViking);
  const usageDatabase = join(baseConfig.storage.workspace, "_system/usage_audit/usage_audit.sqlite3");
  const openVikingTokenUsage = JSON.parse(commandOutput(
    pythonCommand,
    [
      "-c",
      "import json, sqlite3, sys; connection = sqlite3.connect(sys.argv[1]); connection.row_factory = sqlite3.Row; print(json.dumps([dict(row) for row in connection.execute('SELECT source, token_type, provider, model_name, token_count FROM usage_token_hourly ORDER BY source, token_type, provider, model_name')]))",
      usageDatabase,
    ],
  ));
  const memoryTokenUsage = openVikingTokenUsage.filter((row) => row.source === "vlm"
    && row.provider === suite.models.memoryProvider
    && row.model_name === suite.models.memoryRoute);
  const memoryTotalTokens = memoryTokenUsage.reduce((total, row) => total + row.token_count, 0);
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
  await waitForExit(launcher);
  const openVikingChildCleaned = !processAlive(openVikingChildEnvironment.childPid);
  const nativePassed = Object.values(native.checker).every(Boolean);
  const enhancedPassed = Object.values(enhanced.checker).every(Boolean);
  const credentialObservables = [
    readFileSync(settingsPath, "utf8"),
    readFileSync(join(runtimeDir, "openviking.json"), "utf8"),
    JSON.stringify(compiledMemoryModel),
    Buffer.concat(launcherStdout).toString("utf8"),
    Buffer.concat(launcherStderr).toString("utf8"),
  ].join("\n");
  const taskPiCredentialEnvironmentExcluded = [native.condition, enhanced.condition].every((condition) =>
    condition?.credentialEnvironmentPresent === false
    && condition.internalCredentialEnvironmentPresent === false
    && condition.unrelatedCredentialEnvironmentPresent === false
    && condition.ambientOpenRouterCredentialPresent === false);
  const openVikingCredentialEnvironmentIsolated = openVikingChildEnvironment.credentialEnvironmentPresent === false
    && openVikingChildEnvironment.internalCredentialEnvironmentPresent === true
    && openVikingChildEnvironment.ambientOpenRouterCredentialPresent === false
    && openVikingChildEnvironment.unrelatedCredentialEnvironmentPresent === false;
  const credentialRoutedThroughInternalEnvironment = memory.api_key === isolatedOpenRouterCredential.reference
    && compiledMemoryModel.config.vlm.api_key === OPENVIKING_MEMORY_API_KEY_REFERENCE
    && compiledMemoryModel[COMPILED_OPENVIKING_CREDENTIAL]?.value === isolatedOpenRouterApiKey
    && compiledMemoryModel.credentialEnvironmentVariable === QUALITY_CREDENTIAL_ENV
    && qualityEnvironment[QUALITY_CREDENTIAL_ENV] === isolatedOpenRouterApiKey
    && qualityEnvironment.OPENROUTER_API_KEY === QUALITY_AMBIENT_OPENROUTER_SENTINEL
    && qualityEnvironment[QUALITY_UNRELATED_CREDENTIAL_ENV] === QUALITY_UNRELATED_CREDENTIAL_SENTINEL
    && process.env[QUALITY_CREDENTIAL_ENV] === inheritedQualityCredential
    && !credentialObservables.includes(isolatedOpenRouterApiKey);
  const checks = {
    credentialRoutedThroughInternalEnvironment,
    openVikingCredentialEnvironmentIsolated,
    openVikingChildCleaned,
    taskPiCredentialEnvironmentExcluded,
    nativeQuality: nativePassed,
    enhancedQuality: enhancedPassed,
    enhancedContextHookVerified: enhanced.hookVerified && enhanced.observations.hookVerifiedRequests > 0,
    realWorkingMemoryReady: enhanced.observations.workingContextReady > 0,
    actualCheckpointRequiredWait: actualCheckpointFlow.requiredWait,
    actualCheckpointRequestParallel: actualCheckpointFlow.requestContinuedBeforeRefresh,
    actualCheckpointBackgroundAccepted: actualCheckpointFlow.backgroundAccepted,
    memoryUsageAttributed: memoryTokenUsage.length === 2
      && memoryTokenUsage.some((row) => row.token_type === "input" && row.token_count > 0)
      && memoryTokenUsage.some((row) => row.token_type === "output" && row.token_count > 0)
      && memoryTotalTokens > 0,
    sameTaskModel: native.model === taskModel && enhanced.model === taskModel,
    controlledMemoryAdapterSemanticsObserved: memoryRequestSemantics?.model === taskModel
      && memoryRequestSemantics.apiKeyForwarded === true
      && memoryRequestSemantics.reasoningForwarded === false
      && memoryRequestSemantics.temperatureForwarded === true
      && memoryRequestSemantics.temperature === 0
      && memoryRequestSemantics.timeoutForwarded === true,
    pairedConditions: Boolean(native.condition)
      && JSON.stringify(native.condition) === JSON.stringify(enhanced.condition),
  };
  const passed = Object.values(checks).every(Boolean);
  result = {
    schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
    generatedBy: "scripts/validate-context-quality.mjs",
    scope: "real-provider-quality",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    piVersion,
    nodeVersion: process.versions.node,
    openVikingVersion,
    models: { task: taskModel, memory: memoryModel },
    openVikingUsage: { tokenRows: openVikingTokenUsage, memoryTotalTokens },
    actualCheckpointFlow,
    memoryModelCondition: {
      credentialSource: "pi-auth",
      configFingerprint: compiledMemoryModel.configFingerprint,
      explicitRequestControls: explicitMemoryRequestControls,
      controlledAdapterProbe: memoryRequestSemantics,
      reasoningSemantics: memoryRequestSemantics?.reasoningForwarded === false
        ? "provider-default"
        : "adapter-specific",
    },
    fixture: {
      path: "validation/fixtures/context-enhancement-long-task.json",
      name: fixture.name,
      sha256: sha256(readFileSync(fixturePath)),
    },
    execution: {
      order: ["native", "enhanced"],
      repetitions: suite.diagnostics.pairedQualityRepetitions,
    },
    implementation,
    passed,
    checks,
    arms: { native, enhanced },
    limitations: [
      "This is a one-fixture paired diagnostic; it establishes that sample's task quality only when passed is true and does not establish general quality equivalence.",
      "OpenViking memory-token usage is attributed to OpenRouter; complete billed cost still comes from the OpenRouter account and remains a separate comparison stage.",
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
    schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
    generatedBy: "scripts/validate-context-quality.mjs",
    scope: "real-provider-quality",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: false,
    error: redactQualityCredential(error instanceof Error ? error.message : String(error)),
  };
  writeJson(join(artifactRoot, "result.json"), result);
  throw error;
} finally {
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
  await waitForExit(launcher).catch(() => undefined);
  writeFileSync(
    join(artifactRoot, "launcher-stdout.log"),
    redactQualityCredential(Buffer.concat(launcherStdout).toString("utf8")),
  );
  writeFileSync(
    join(artifactRoot, "launcher-stderr.log"),
    redactQualityCredential(Buffer.concat(launcherStderr).toString("utf8")),
  );
}
