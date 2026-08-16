#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import {
  assertValidationPiVersion,
  readProjectOpenVikingVersion,
  readValidationSuite,
} from "./validation-suite.mjs";
import { FileLongTermMemory } from "../.pi/extensions/pi-context-memory/long-term-memory.ts";
import {
  compileOpenVikingConfig,
  OPENVIKING_RUNTIME_SCHEMA_VERSION,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import { SessionMemoryCoordinator } from "../.pi/extensions/pi-context-memory/session-memory-coordination.ts";
import { normalizeCommitResult, normalizeSessionContext } from "../.pi/extensions/pi-context-memory/openviking-protocol.ts";
import {
  MEMORY_CAPABILITY_PROBE_VERSION,
  MEMORY_CAPABILITY_PROOF_VERSION,
} from "../.pi/extensions/pi-context-memory/memory-runtime-capability.ts";
import {
  currentTurnToolSources,
  projectRoute,
  sanitizeFullOutputLocators,
} from "../.pi/extensions/pi-context-memory/pi-session-protocol.ts";
import {
  createOpenAICompletionsPayloadProof,
  openAICompletionsPayloadMatches,
  openAICompletionsPayloadMatchesProfile,
  openAICompletionsToolPayloadUpperBoundBytes,
} from "../.pi/extensions/pi-context-memory/provider-payload-proof.ts";
import {
  DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS,
  MAX_OPENVIKING_APPEND_BODY_BYTES,
  MAX_OPENVIKING_PROJECTION_BYTES,
  OpenVikingSessionMemory,
  projectMemorySources,
} from "../.pi/extensions/pi-context-memory/session-working-memory.ts";
import {
  assemblyRouteProofError,
  buildEnhancedContext,
  createProviderPayloadProfile,
  createRetentionBudgetIdentity,
  formatWorkingContext,
  payloadCarriesEnhancedContent,
  WorkingContextOptimizer,
} from "../.pi/extensions/pi-context-memory/working-context-optimization.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-context-enhancement.mjs");
const suite = readValidationSuite(root);
const piVersion = assertValidationPiVersion(root);
const openVikingCompatibilityTarget = readProjectOpenVikingVersion(root);
const runId = process.env.PCR_RUN_ID ?? `context-enhancement-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/context-enhancement", runId);
const fixturePath = join(root, "validation/fixtures/context-enhancement-long-task.json");
const evidencePath = join(root, "validation/evidence/context-enhancement.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const SUMMARY_CONTAMINATION_SENTINELS = [
  "PCR_SUMMARY_CONTAMINATION_BRANCH",
  "PCR_SUMMARY_CONTAMINATION_COMPACTION",
  "PCR_SUMMARY_CONTAMINATION_RETAINED_TAIL",
];
mkdirSync(artifactRoot, { recursive: true });
const implementation = captureImplementationEvidence(root, "context-enhancement");
const startedAt = new Date().toISOString();
const MEMORY_STATUS = {
  initializing: "增强记忆 · 初始化中",
  active: "增强记忆",
  faulted: "增强记忆 · 故障",
};
const enhancementStatuses = new Set(Object.values(MEMORY_STATUS));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function replaceJson(path, value) {
  const pending = `${path}.pending`;
  writeJson(pending, value);
  renameSync(pending, path);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function locatePiDist() {
  const command = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(command, ["pi"], { encoding: "utf8" }).stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  if (!located) throw new Error("Cannot locate the Pi executable");
  return dirname(realpathSync(located));
}

const {
  buildContextEntries,
  convertToLlm,
  sessionEntryToContextMessages,
} = await import(pathToFileURL(join(locatePiDist(), "index.js")).href);

const profile = {
  id: "pi-provider-protocol-v1",
  contextEntries: (entries, leafId) => buildContextEntries([...entries], leafId),
  providerMessages: (entry) => convertToLlm(sessionEntryToContextMessages(entry)),
};

function routeEntries(name) {
  const ids = fixture.routes[name];
  if (!Array.isArray(ids)) throw new Error(`Fixture route ${name} is unavailable`);
  return ids.map((id) => {
    const entry = fixture.entries[id];
    if (!entry) throw new Error(`Fixture entry ${id} is unavailable`);
    return structuredClone(entry);
  });
}

function snapshot(identity, entries) {
  return {
    ...identity,
    leafId: entries.at(-1)?.id ?? null,
    entries,
  };
}

function activeRouteEntries(entries, leafId) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const route = [];
  let currentId = leafId;
  while (currentId) {
    const entry = byId.get(currentId);
    if (!entry) throw new Error(`Active route entry ${currentId} is unavailable`);
    route.push(entry);
    currentId = entry.parentId;
  }
  return route.reverse();
}
function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolveBody(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function textOfProjection(message) {
  return typeof message?.content === "string" ? message.content : "";
}

function assembledMessage(message, index) {
  return {
    id: `fake-${index}`,
    role: message.role,
    parts: [{ type: "text", text: message.content }],
    created_at: message.created_at,
    turn_id: message.turn_id,
    message_kind: message.message_kind,
    source_message_ids: message.source_message_ids,
  };
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function startOpenVikingDouble() {
  const state = {
    sessions: new Map(),
    allSessions: new Map(),
    createdSessions: 0,
    createRequests: 0,
    tasks: new Map(),
    requests: [],
    deletedSessions: [],
    createResponseDelayMs: 0,
    contextResponseDelayMs: 0,
    taskPollsBeforeCompletion: 2,
    skipNextCommit: false,
    failNextContext: false,
    failContextCount: 0,
    providerRequests: 0,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const observedRequest = { method: request.method, path: url.pathname };
      state.requests.push(observedRequest);
      const body = await readBody(request);
      observedRequest.bodyBytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body), "utf8");
      if (Array.isArray(body?.messages)) {
        observedRequest.maxMessageBytes = Math.max(0, ...body.messages.map((message) => Buffer.byteLength(JSON.stringify(message), "utf8")));
        observedRequest.hasBoundedProjection = body.messages.some((message) => String(message?.content).includes("[OpenViking projection bounded;"));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
        const id = body?.session_id;
        if (typeof id !== "string" || !body?.memory_policy?.working_memory?.enabled) {
          send(response, 400, { status: "error", error: { message: "invalid session" } });
          return;
        }
        state.createRequests += 1;
        if (state.createResponseDelayMs > 0) await sleep(state.createResponseDelayMs);
        const session = { id, messages: [], pendingArchive: [], pendingTokens: 0, overview: "", batches: [], commits: 0 };
        state.sessions.set(id, session);
        state.allSessions.set(id, session);
        state.createdSessions += 1;
        send(response, 200, { status: "ok", result: { session_id: id, uri: `viking://session/${id}` } });
        return;
      }
      const deleteMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const sessionId = decodeURIComponent(deleteMatch[1]);
        const deleted = state.sessions.delete(sessionId);
        if (deleted) state.deletedSessions.push(sessionId);
        send(response, deleted ? 200 : 404, deleted
          ? { status: "ok", result: { session_id: sessionId } }
          : { status: "error", error: { message: "session not found" } });
        return;
      }

      const batchMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages\/batch$/);
      if (request.method === "POST" && batchMatch) {
        const session = state.sessions.get(decodeURIComponent(batchMatch[1]));
        if (!session || !Array.isArray(body?.messages)) {
          send(response, 404, { status: "error", error: { message: "session not found" } });
          return;
        }
        session.batches.push(structuredClone(body.messages));
        session.messages.push(...structuredClone(body.messages));
        session.pendingTokens += body.messages.reduce((total, message) => total + Math.max(1, Math.ceil(textOfProjection(message).length / 4)), 0);
        send(response, 200, {
          status: "ok",
          result: {
            session_id: session.id,
            message_count: session.messages.length,
            added: body.messages.length,
            pending_tokens: session.pendingTokens,
          },
        });
        return;
      }

      const commitMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/commit$/);
      if (request.method === "POST" && commitMatch) {
        const session = state.sessions.get(decodeURIComponent(commitMatch[1]));
        if (!session) {
          send(response, 404, { status: "error", error: { message: "session not found" } });
          return;
        }
        session.commits += 1;
        const keepRecent = Number.isSafeInteger(body?.keep_recent_count) ? body.keep_recent_count : 0;
        if (state.skipNextCommit) {
          state.skipNextCommit = false;
          session.pendingTokens = 0;
          send(response, 200, {
            status: "ok",
            result: {
              session_id: session.id,
              status: "skipped",
              task_id: null,
              archive_uri: null,
              archived: false,
              reason: "all_within_keep_window",
            },
          });
          return;
        }
        const taskId = `task-${state.tasks.size + 1}`;
        const archiveCount = Math.max(0, session.messages.length - keepRecent);
        const archivedMessages = session.messages.slice(0, archiveCount);
        session.pendingArchive.push(...structuredClone(archivedMessages));
        session.messages = session.messages.slice(archiveCount);
        session.pendingTokens = 0;
        state.tasks.set(taskId, {
          id: taskId,
          status: "pending",
          polls: 0,
          completeAfterPolls: state.taskPollsBeforeCompletion,
          session,
          archivedMessages,
        });
        send(response, 200, {
          status: "ok",
          result: {
            session_id: session.id,
            status: "accepted",
            task_id: taskId,
            archive_uri: `viking://session/${session.id}/archive/${session.commits}`,
            archived: true,
          },
        });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        const task = state.tasks.get(decodeURIComponent(taskMatch[1]));
        if (!task) {
          send(response, 404, { status: "error", error: { message: "task not found" } });
          return;
        }
        task.polls += 1;
        if (task.polls >= task.completeAfterPolls && task.status !== "completed") {
          task.status = "completed";
          task.session.overview = [
            task.session.overview,
            "# Working Memory",
            "## Session Title\nLocal validation",
            "## Current State\nReady",
            "## Task & Goals\nValidate current route",
            `## Key Facts & Decisions\n${task.archivedMessages.map((message) => textOfProjection(message)).join("\n\n")}`,
            "## Files & Context\nPi sources",
            "## Errors & Corrections\nNone",
            "## Open Issues\nNone",
          ].filter(Boolean).join("\n\n");
          task.session.pendingArchive.splice(0, task.archivedMessages.length);
        }
        send(response, 200, { status: "ok", result: { task_id: task.id, status: task.status } });
        return;
      }

      const contextMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/context$/);
      if (request.method === "GET" && contextMatch) {
        if (state.failNextContext || state.failContextCount > 0) {
          state.failNextContext = false;
          state.failContextCount = Math.max(0, state.failContextCount - 1);
          send(response, 503, { status: "error", error: { message: "controlled context failure" } });
          return;
        }
        if (state.contextResponseDelayMs > 0) await sleep(state.contextResponseDelayMs);
        const session = state.sessions.get(decodeURIComponent(contextMatch[1]));
        if (!session) {
          send(response, 404, { status: "error", error: { message: "session not found" } });
          return;
        }
        const messages = [...session.pendingArchive, ...session.messages].map(assembledMessage);
        send(response, 200, {
          status: "ok",
          result: {
            latest_archive_overview: session.overview,
            pre_archive_abstracts: [],
            messages,
            estimatedTokens: Math.ceil((session.overview.length + JSON.stringify(messages).length) / 4),
            stats: {
              totalArchives: session.commits,
              includedArchives: session.overview ? 1 : 0,
              droppedArchives: 0,
              failedArchives: 0,
              activeTokens: session.pendingTokens,
              archiveTokens: Math.ceil(session.overview.length / 4),
            },
          },
        });
        return;
      }

      send(response, 404, { status: "error", error: { message: "unknown endpoint" } });
    } catch (error) {
      send(response, 500, { status: "error", error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenViking double did not publish an address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}
function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(readValue, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("Pi process did not exit")), timeoutMs)),
  ]);
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
        event._receivedAt = Date.now();
        this.events.push(event);
        if (event.type === "response" && event.id && this.pending.has(event.id)) {
          this.pending.get(event.id)(event);
          this.pending.delete(event.id);
        }
      }
    });
  }

  send(type, fields = {}) {
    const id = `${type}-${Math.random()}`;
    const result = new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`RPC ${type} timed out`));
      }, 30_000);
      this.pending.set(id, (response) => {
        clearTimeout(timeout);
        if (!response.success) rejectResponse(new Error(response.error ?? `RPC ${type} failed`));
        else resolveResponse(response);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return result;
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    await waitForExit(this.child);
  }
}

async function startLocalProvider() {
  const state = { payloads: [], receivedAt: [], promptTokens: 32, rejectEnhancedOverflow: false };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      send(response, 404, { error: { message: "unknown provider endpoint" } });
      return;
    }
    await sleep(10);
    state.receivedAt.push(Date.now());
    state.payloads.push(body);
    if (state.rejectEnhancedOverflow && JSON.stringify(body).includes("# Enhanced session context")) {
      send(response, 400, {
        error: {
          message: "This model's maximum context length is 1024 tokens. However, your messages resulted in 2048 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      });
      return;
    }
    const id = `chatcmpl-${state.payloads.length}`;
    const created = Math.floor(Date.now() / 1_000);
    const completionTokens = 4;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = messages.findLast((message) => message?.role === "user");
    const currentPrompt = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const toolNames = currentPrompt.includes("current-turn projected tool probe")
      || currentPrompt.includes("current-turn source mutation probe")
      ? ["validation_large", "validation_full", "validation_error"]
      : currentPrompt.includes("current-turn raw tool probe")
        ? ["validation_small", "validation_error"]
        : [];
    const resultNames = new Set(messages
      .filter((message) => message?.role === "tool")
      .map((message) => typeof message.tool_call_id === "string"
        ? toolNames.find((name) => message.tool_call_id.startsWith(`${name}-`))
        : undefined));
    if (toolNames.length > 0 && !toolNames.every((name) => resultNames.has(name))) {
      const toolCalls = toolNames.map((name, index) => ({
        index,
        id: `${name}-${state.payloads.length}`,
        type: "function",
        function: { name, arguments: "{}" },
      }));
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: state.promptTokens, completion_tokens: completionTokens, total_tokens: state.promptTokens + completionTokens } })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: `local response ${state.payloads.length}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: state.promptTokens, completion_tokens: completionTokens, total_tokens: state.promptTokens + completionTokens } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local Provider did not publish an address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    state,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

function readObservations(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function controlledCapabilityProof(launchId, settingsFingerprint, compiled, configFingerprint = compiled.configFingerprint) {
  const completedAtMs = Date.now() - 1_000;
  const completedAt = new Date(completedAtMs).toISOString();
  return {
    proofVersion: MEMORY_CAPABILITY_PROOF_VERSION,
    proofId: `controlled-${createHash("sha256").update(`${launchId}\0${settingsFingerprint}\0${configFingerprint}`).digest("hex").slice(0, 24)}`,
    probeVersion: MEMORY_CAPABILITY_PROBE_VERSION,
    launchId,
    childPid: process.pid,
    provider: compiled.profile.provider,
    model: compiled.profile.model,
    api: compiled.profile.api,
    settingsFingerprint,
    configFingerprint,
    profileFingerprint: compiled.profileFingerprint,
    adapterVersion: compiled.profile.adapterVersion,
    taskId: "controlled-capability-task",
    assemblyHash: createHash("sha256").update(`${launchId}\0assembly`).digest("hex"),
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    completedAt,
  };
}


async function runPiAdoptionCase(openViking) {
  const caseDir = join(artifactRoot, "pi-adoption");
  const home = join(caseDir, "home");
  const agentDir = join(caseDir, "pi-agent");
  const runtimeDir = join(caseDir, "runtime");
  const observationLog = join(caseDir, "observations.jsonl");
  const archiveRoot = join(caseDir, "archive");
  const settingsPath = join(caseDir, "memory-model.jsonc");
  const settingsTargetDir = join(caseDir, "memory-model-target");
  const settingsTargetPath = join(settingsTargetDir, "memory-model.jsonc");
  const providerPath = join(caseDir, "local-provider.ts");
  const lifecycleControlPath = join(caseDir, "lifecycle-control.ts");
  const handlerOrderLog = join(caseDir, "handler-order.jsonl");
  const runtimeRevocationPath = join(caseDir, "runtime-revocation.ts");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeJson(join(agentDir, "settings.json"), {
    compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
  });
  mkdirSync(runtimeDir, { recursive: true });
  const memorySetting = {
    provider: suite.models.memoryProvider,
    model: suite.models.memoryRoute,
    api_key: "local-validation",
  };
  const settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(memorySetting).sort(([left], [right]) => left.localeCompare(right)))))
    .digest("hex");
  const compiledMemoryConfig = await compileOpenVikingConfig(root, memorySetting, {
    ...process.env,
    HOME: home,
  });
  mkdirSync(settingsTargetDir, { recursive: true });
  writeFileSync(settingsTargetPath, `${JSON.stringify({ memoryModel: memorySetting })}\n`, "utf8");
  symlinkSync(settingsTargetPath, settingsPath);

  let launchId = `context-enhancement-${process.pid}`;
  writeJson(join(runtimeDir, "launcher.lock"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
  });
  writeJson(join(runtimeDir, "launcher.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    controlUrl: "http://127.0.0.1:1",
    operationTimeoutMs: 30_000,
  });
  const writeRuntimeState = (
    activeSettingsFingerprint,
    activeConfigFingerprint = compiledMemoryConfig.configFingerprint,
  ) => writeJson(join(runtimeDir, "state.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    childPid: process.pid,
    phase: "ready",
    ready: true,
    serviceReady: true,
    requestReady: true,
    activeProvider: memorySetting.provider,
    activeModel: memorySetting.model,
    activeSettingsFingerprint,
    activeConfigFingerprint,
    activeProfile: compiledMemoryConfig.profile,
    activeProfileFingerprint: compiledMemoryConfig.profileFingerprint,
    memoryCapability: controlledCapabilityProof(
      launchId,
      activeSettingsFingerprint,
      compiledMemoryConfig,
      activeConfigFingerprint,
    ),
    targetProvider: memorySetting.provider,
    targetModel: memorySetting.model,
    targetSettingsFingerprint: activeSettingsFingerprint,
    targetConfigFingerprint: activeConfigFingerprint,
    targetProfileFingerprint: compiledMemoryConfig.profileFingerprint,
  });
  const replaceRuntimeGeneration = (suffix) => {
    launchId = `${launchId}-${suffix}`;
    writeJson(join(runtimeDir, "launcher.lock"), {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId,
      launcherPid: process.pid,
    });
    writeJson(join(runtimeDir, "launcher.json"), {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId,
      launcherPid: process.pid,
      controlUrl: "http://127.0.0.1:1",
      operationTimeoutMs: 30_000,
    });
    writeRuntimeState(settingsFingerprint);
  };
  writeRuntimeState("wrong-settings-fingerprint");

  const provider = await startLocalProvider();
  writeFileSync(providerPath, `export default function localProvider(pi) {
  pi.registerProvider("context-enhancement-validation", {
    name: "Context Enhancement Validation",
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 256 }],
  });
}\n`, "utf8");
  writeFileSync(lifecycleControlPath, [
    "import { appendFileSync } from \"node:fs\";",
    "export default function lifecycleControl(pi) {",
    "  let cancelNextTree = false;",
    "  let exposeNativeSummary = false;",
    "  const record = (event, data = {}) => appendFileSync(process.env.PCR_HANDLER_ORDER_LOG, `${JSON.stringify({ event, handler: \"lifecycle-control\", ...data })}\\n`, \"utf8\");",
    "  pi.on(\"session_before_compact\", (event) => { record(\"session_before_compact\", { reason: event.reason }); });",
    "  pi.on(\"session_before_tree\", (event) => {",
    "    record(\"session_before_tree\", { userWantsSummary: event.preparation.userWantsSummary });",
    "    if (cancelNextTree) { cancelNextTree = false; return { cancel: true }; }",
    "    if (exposeNativeSummary) { exposeNativeSummary = false; return { customInstructions: \"controlled later handler requires native summary\" }; }",
    "  });",
    "  pi.registerCommand(\"validation-tree\", {",
    "    description: \"Navigate the validation session tree\",",
    "    handler: async (args, ctx) => {",
    "      const [targetId, mode] = args.trim().split(/\\s+/);",
    "      if (!targetId || ![\"plain\", \"summary\", \"native-summary\"].includes(mode)) throw new Error(\"Usage: /validation-tree <entry-id> <plain|summary|native-summary>\");",
    "      exposeNativeSummary = mode === \"native-summary\";",
    "      await ctx.navigateTree(targetId, { summarize: mode !== \"plain\" });",
    "    },",
    "  });",
    "  pi.registerCommand(\"validation-cancel-tree\", {",
    "    description: \"Cancel the next validation tree navigation\",",
    "    handler: async (args, ctx) => {",
    "      cancelNextTree = true;",
    "      await ctx.navigateTree(args.trim(), { summarize: false });",
    "    },",
    "  });",
    "  pi.registerCommand(\"validation-reload\", {",
    "    description: \"Reload the validation runtime\",",
    "    handler: async (_args, ctx) => { await ctx.reload(); },",
    "  });",
    "}",
    "",
  ].join("\n"), "utf8");
  writeFileSync(runtimeRevocationPath, [
    "import { readFileSync, writeFileSync } from \"node:fs\";",
    `const runtimeStatePath = ${JSON.stringify(join(runtimeDir, "state.json"))};`,
    "export default function runtimeRevocation(pi) {",
    "  pi.on(\"before_provider_request\", (event) => {",
    "    if (!JSON.stringify(event.payload).includes(\"runtime process revocation probe\")) return;",
    "    const state = JSON.parse(readFileSync(runtimeStatePath, \"utf8\"));",
    "    writeFileSync(runtimeStatePath, `${JSON.stringify({ ...state, childPid: 999999999 })}\\n`, \"utf8\");",
    "  });",
    "}",
    "",
  ].join("\n"), "utf8");

  const child = spawn("pi", [
    "--mode", "rpc",
    "--model", "context-enhancement-validation/local",
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--extension", runtimeRevocationPath,
    "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
    "--extension", providerPath,
    "--extension", lifecycleControlPath,
    "--no-tools",
  ], {
    cwd: root,
    env: {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_MEMORY_MODEL_SETTINGS: settingsPath,
      PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
      PCR_OPENVIKING_URL: openViking.baseUrl,
      PCR_CHECKPOINT_COMMIT_PENDING_TOKENS: "1",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: archiveRoot,
      PCR_HANDLER_ORDER_LOG: handlerOrderLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new RpcClient(child);
  try {
    await waitFor(() => client.events.some((event) => event.type === "extension_ui_request" && event.method === "setStatus"), "Pi startup");
    await sleep(300);
    await client.send("prompt", { message: "first persisted prompt # Enhanced session context" });
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "agent_settled"),
      "first Pi agent settlement",
    );
    await sleep(500);
    const spoofedMarkerObservations = readObservations(observationLog);
    const spoofedMarkerTransportCount = provider.state.payloads.length;
    writeRuntimeState(settingsFingerprint, "wrong-config-fingerprint");
    await client.send("prompt", { message: "second mismatched-runtime prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 2,
      "second Pi agent settlement",
    );
    writeRuntimeState(settingsFingerprint);
    await client.send("prompt", { message: "third route preparation prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 3,
      "third Pi agent settlement",
    );
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "checkpoint_refresh_complete"),
      "agent-settled checkpoint refresh",
      10_000,
    );
    const fourthObservationOffset = readObservations(observationLog).length;
    const fourthProviderOffset = provider.state.payloads.length;
    await client.send("prompt", { message: "fourth current prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 4,
      "fourth Pi agent settlement",
    );
    const fourthRun = {
      observations: readObservations(observationLog).slice(fourthObservationOffset),
      payloads: provider.state.payloads.slice(fourthProviderOffset),
    };
    const rechecksBeforeDesiredChange = readObservations(observationLog)
      .filter((event) => event.type === "memory_model_generation_recheck").length;
    writeFileSync(settingsTargetPath, `${JSON.stringify({ memoryModel: null })}\n`, "utf8");
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "memory_model_generation_recheck").length > rechecksBeforeDesiredChange,
      "post-ready desired configuration recheck",
    );
    const desiredMismatchObservationOffset = readObservations(observationLog).length;
    const desiredMismatchProviderOffset = provider.state.payloads.length;
    await client.send("prompt", { message: "fifth post-ready mismatch prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 5,
      "fifth Pi agent settlement",
    );
    const desiredMismatchRun = {
      observations: readObservations(observationLog).slice(desiredMismatchObservationOffset),
      payloads: provider.state.payloads.slice(desiredMismatchProviderOffset),
    };
    const desiredRecoveryRecheckOffset = readObservations(observationLog).length;
    writeFileSync(settingsTargetPath, `${JSON.stringify({ memoryModel: memorySetting })}\n`, "utf8");
    await waitFor(
      () => readObservations(observationLog).slice(desiredRecoveryRecheckOffset)
        .some((event) => event.type === "memory_model_generation_recheck"),
      "post-mismatch desired configuration recheck",
    );
    const promptAndSettle = async (message) => {
      const observationOffset = readObservations(observationLog).length;
      const providerOffset = provider.state.payloads.length;
      const settledBefore = readObservations(observationLog).filter((event) => event.type === "agent_settled").length;
      await client.send("prompt", { message });
      await waitFor(
        () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length > settledBefore,
        `settlement for ${message}`,
      );
      return {
        observations: readObservations(observationLog).slice(observationOffset),
        payloads: provider.state.payloads.slice(providerOffset),
        receivedAt: provider.state.receivedAt.slice(providerOffset),
      };
    };
    const runTreeNavigation = async (targetId, mode) => {
      const treeEventsBefore = readObservations(observationLog).filter((event) => event.type === "session_tree").length;
      await client.send("prompt", { message: `/validation-tree ${targetId} ${mode}` });
      return waitFor(
        () => {
          const events = readObservations(observationLog).filter((event) => event.type === "session_tree");
          return events.length > treeEventsBefore ? events.at(-1) : undefined;
        },
        `tree navigation to ${targetId}`,
      );
    };
    const waitForWorkingContextAfter = (observationOffset, expected) => waitFor(
      () => readObservations(observationLog).slice(observationOffset).find((event) =>
        event.type === "checkpoint_refresh_complete"
        && event.sessionId === expected.sessionId
        && event.sessionFile === expected.sessionFile
        && event.leafId === expected.leafId),
      `checkpoint refresh for ${expected.sessionId}/${expected.leafId}`,
      10_000,
    );
    const waitForCurrentWorkingContext = async (observationOffset) => {
      const state = (await client.send("get_state")).data;
      const leafId = (await client.send("get_entries")).data.leafId;
      await waitForWorkingContextAfter(observationOffset, { ...state, leafId });
      return { ...state, leafId };
    };
    const requestAdoptedFor = (run, expected) => run.observations.some((event) =>
      event.type === "before_provider_request"
      && event.sessionId === expected.sessionId
      && event.sessionFile === expected.sessionFile
      && event.hookOutcome === "verified"
      && event.contextAuthorization === "allowed"
      && run.payloads.some((payload) => createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex") === event.payloadHash));

    const stableRuntimeRun = await promptAndSettle("sixth desired configuration remains active prompt");
    await promptAndSettle("seventh lifecycle baseline prompt");
    const backendFailureOffset = readObservations(observationLog).length;
    openViking.state.failContextCount = 1;
    await promptAndSettle("backend failure preparation prompt");
    await waitFor(
      () => readObservations(observationLog).slice(backendFailureOffset).some((event) => event.type === "checkpoint_refresh_error"),
      "Pi checkpoint refresh failure observation",
      10_000,
    );
    openViking.state.contextResponseDelayMs = 0;
    const backendNativeRun = await promptAndSettle("backend failure native probe");
    openViking.state.contextResponseDelayMs = 0;
    const archiveFailureOffset = readObservations(observationLog).length;
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "archive_complete"),
      "archive baseline",
      10_000,
    );
    const archivedSessionId = readObservations(observationLog)
      .findLast((event) => event.type === "archive_complete")?.sessionId;
    assert(archivedSessionId, "Archive failure fixture has no persisted session identity");
    const archiveSessionDirectory = join(
      archiveRoot,
      createHash("sha256").update(archivedSessionId).digest("hex"),
    );
    const sourcesDirectory = join(archiveSessionDirectory, "sources");
    const sourcesBackup = `${sourcesDirectory}.validation-backup`;
    renameSync(sourcesDirectory, sourcesBackup);
    writeFileSync(sourcesDirectory, "blocked");
    let archiveBlockedRun;
    let archiveStorageRestored = false;
    try {
      await promptAndSettle("archive failure preparation prompt");
      await waitFor(
        () => readObservations(observationLog).slice(archiveFailureOffset)
          .some((event) => (event.type === "archive_error")
            || (event.type === "generation_fault_latched" && event.fault === "source-barrier")),
        "archive/source barrier failure observation",
        10_000,
      );
      rmSync(sourcesDirectory, { force: true });
      renameSync(sourcesBackup, sourcesDirectory);
      archiveStorageRestored = true;
      archiveBlockedRun = await promptAndSettle("archive failure latched probe");
    } finally {
      if (!archiveStorageRestored) {
        rmSync(sourcesDirectory, { force: true });
        renameSync(sourcesBackup, sourcesDirectory);
      }
    }
    const archiveGenerationRechecksBeforeRepair = readObservations(observationLog)
      .filter((event) => event.type === "memory_model_generation_recheck").length;
    replaceRuntimeGeneration("archive-revalidated");
    await waitFor(
      () => readObservations(observationLog)
        .filter((event) => event.type === "memory_model_generation_recheck").length > archiveGenerationRechecksBeforeRepair,
      "explicit archive repair generation observation",
      10_000,
    );
    const archiveRecoveryReadyState = await waitForCurrentWorkingContext(archiveFailureOffset);
    const archiveRecoveredRun = await promptAndSettle("archive recovery enhanced probe");

    const originalState = (await client.send("get_state")).data;
    const originalEntriesResponse = await client.send("get_entries");
    const originalEntries = originalEntriesResponse.data.entries;
    const originalLeafId = originalEntriesResponse.data.leafId;
    const assistantEntries = originalEntries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
    const userEntries = originalEntries.filter((entry) => entry.type === "message" && entry.message?.role === "user");
    assert(assistantEntries.length >= 3 && userEntries.length >= 2 && originalLeafId, "Pi lifecycle fixture has insufficient entries");
    const branchPointId = assistantEntries[1].id;
    const plainToBranchPoint = await runTreeNavigation(branchPointId, "plain");
    await promptAndSettle("conflicting branch B lifecycle prompt");
    const branchBEntriesResponse = await client.send("get_entries");
    const branchBLeafId = branchBEntriesResponse.data.leafId;
    assert(branchBLeafId && branchBLeafId !== originalLeafId, "Tree branch B was not created");
    const plainAOffset = readObservations(observationLog).length;
    const plainToA = await runTreeNavigation(originalLeafId, "plain");
    const plainAState = await waitForCurrentWorkingContext(plainAOffset);
    const plainARun = await promptAndSettle("tree route A adoption probe");
    const summaryBOffset = readObservations(observationLog).length;
    const summaryProviderOffset = provider.state.payloads.length;
    const summaryToB = await runTreeNavigation(branchBLeafId, "summary");
    const summaryProviderRequests = provider.state.payloads.length - summaryProviderOffset;
    const summaryBState = await waitForCurrentWorkingContext(summaryBOffset);
    const summaryBRun = await promptAndSettle("tree summary-suppressed route B adoption probe");
    const returnAOffset = readObservations(observationLog).length;
    const returnToA = await runTreeNavigation(originalLeafId, "plain");
    const returnAState = await waitForCurrentWorkingContext(returnAOffset);
    const returnARun = await promptAndSettle("tree route A return adoption probe");
    const nativeSummaryOffset = readObservations(observationLog).length;
    const nativeSummaryProviderOffset = provider.state.payloads.length;
    const nativeSummaryToB = await runTreeNavigation(branchBLeafId, "native-summary");
    const nativeSummaryProviderRequests = provider.state.payloads.length - nativeSummaryProviderOffset;
    const nativeSummaryObservations = readObservations(observationLog).slice(nativeSummaryOffset);
    const afterNativeSummaryOffset = readObservations(observationLog).length;
    await runTreeNavigation(originalLeafId, "plain");
    await waitForCurrentWorkingContext(afterNativeSummaryOffset);
    const treeCountBeforeCancellation = readObservations(observationLog).filter((event) => event.type === "session_tree").length;
    const statusBeforeCancellation = client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText;
    await client.send("prompt", { message: `/validation-cancel-tree ${branchBLeafId}` });
    await sleep(50);
    const canceledTreeStatusStable = enhancementStatuses.has(statusBeforeCancellation)
      && client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText === statusBeforeCancellation
      && readObservations(observationLog).filter((event) => event.type === "session_tree").length === treeCountBeforeCancellation;
    const rootObservationOffset = readObservations(observationLog).length;
    const rootNavigation = await runTreeNavigation(userEntries[0].id, "plain");
    const rootRun = await promptAndSettle("tree root native probe");
    const rootObservations = readObservations(observationLog).slice(rootObservationOffset);
    const finalAOffset = readObservations(observationLog).length;
    await runTreeNavigation(originalLeafId, "plain");
    await waitForCurrentWorkingContext(finalAOffset);

    const forkStartedAfter = readObservations(observationLog).length;
    const forkResponse = await client.send("fork", { entryId: userEntries[1].id });
    const forkState = (await client.send("get_state")).data;
    assert(forkResponse.data.cancelled === false, "Fork was cancelled");
    const forkReadyState = await waitForCurrentWorkingContext(forkStartedAfter);
    const forkRun = await promptAndSettle("fork session adoption probe");
    const resumeStartedAfter = readObservations(observationLog).length;
    await client.send("switch_session", { sessionPath: originalState.sessionFile });
    const resumedState = (await client.send("get_state")).data;
    const resumedLeafId = (await client.send("get_entries")).data.leafId;
    await waitForWorkingContextAfter(resumeStartedAfter, { ...resumedState, leafId: resumedLeafId });
    const resumedRun = await promptAndSettle("post-resume adoption prompt");

    const cloneStartedAfter = readObservations(observationLog).length;
    const cloneResponse = await client.send("clone");
    const cloneState = (await client.send("get_state")).data;
    assert(cloneResponse.data.cancelled === false, "Clone was cancelled");
    const cloneReadyState = await waitForCurrentWorkingContext(cloneStartedAfter);
    const cloneRun = await promptAndSettle("clone session adoption probe");
    const cloneResumeStartedAfter = readObservations(observationLog).length;
    await client.send("switch_session", { sessionPath: originalState.sessionFile });
    const cloneResumeState = (await client.send("get_state")).data;
    const cloneResumeLeafId = (await client.send("get_entries")).data.leafId;
    await waitForWorkingContextAfter(cloneResumeStartedAfter, { ...cloneResumeState, leafId: cloneResumeLeafId });
    const cloneResumeRun = await promptAndSettle("clone post-resume adoption probe");
    const reloadStartedAfter = readObservations(observationLog).length;
    await client.send("prompt", { message: "/validation-reload" });
    const reloadedState = (await client.send("get_state")).data;
    const reloadedLeafId = (await client.send("get_entries")).data.leafId;
    await waitForWorkingContextAfter(reloadStartedAfter, { ...reloadedState, leafId: reloadedLeafId });
    const reloadRun = await promptAndSettle("post-reload adoption prompt");
    const compactionEntriesBefore = (await client.send("get_entries")).data.entries
      .filter((entry) => entry.type === "compaction").length;
    const compactStatusBeforeSuppression = client.events
      .filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText;

    const manualObservationOffset = readObservations(observationLog).length;
    const manualProviderOffset = provider.state.payloads.length;
    const manualCancelled = await client.send("compact")
      .then(() => false, (error) => String(error?.message ?? error).includes("cancelled"));
    const manualObservations = readObservations(observationLog).slice(manualObservationOffset);
    const manualSuppressed = manualCancelled
      && provider.state.payloads.length === manualProviderOffset
      && manualObservations.some((event) => event.type === "session_before_compact" && event.reason === "manual" && event.decision === "cancel")
      && !manualObservations.some((event) => event.type === "session_compact")
      && client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText === compactStatusBeforeSuppression;
    const manualState = (await client.send("get_state")).data;
    const manualLeafId = (await client.send("get_entries")).data.leafId;
    const manualAdoptionRun = await promptAndSettle("manual compaction suppression continuation probe");

    const thresholdObservationOffset = readObservations(observationLog).length;
    provider.state.promptTokens = 16_000;
    const thresholdRun = await promptAndSettle("threshold compaction suppression prompt");
    provider.state.promptTokens = 32;
    const thresholdObservations = readObservations(observationLog).slice(thresholdObservationOffset);
    const thresholdSuppressed = thresholdObservations.some((event) =>
      event.type === "session_before_compact" && event.reason === "threshold" && event.decision === "cancel")
      && !thresholdObservations.some((event) => event.type === "session_compact")
      && thresholdRun.payloads.length === 1;
    const thresholdState = (await client.send("get_state")).data;
    const thresholdLeafId = (await client.send("get_entries")).data.leafId;
    const thresholdAdoptionRun = await promptAndSettle("threshold compaction suppression continuation probe");

    await promptAndSettle("overflow preparation one");
    await promptAndSettle("overflow preparation two");
    const overflowObservationOffset = readObservations(observationLog).length;
    provider.state.rejectEnhancedOverflow = true;
    const overflowRun = await promptAndSettle("overflow compaction suppression prompt");
    provider.state.rejectEnhancedOverflow = false;
    const overflowObservations = readObservations(observationLog).slice(overflowObservationOffset);
    const overflowVerifiedRequests = overflowObservations
      .filter((event) => event.type === "before_provider_request" && event.hookOutcome === "verified");
    const overflowSuppressed = overflowObservations.some((event) =>
      event.type === "session_before_compact"
      && event.reason === "overflow"
      && event.willRetry === true
      && event.decision === "cancel")
      && !overflowObservations.some((event) => event.type === "session_compact")
      && overflowRun.payloads.length === 1
      && overflowVerifiedRequests.length === 1;
    const overflowState = (await client.send("get_state")).data;
    const overflowLeafId = (await client.send("get_entries")).data.leafId;
    const overflowAdoptionRun = await promptAndSettle("overflow compaction suppression continuation probe");
    const compactionEntriesAfter = (await client.send("get_entries")).data.entries
      .filter((entry) => entry.type === "compaction").length;
    const handlerOrder = existsSync(handlerOrderLog)
      ? readFileSync(handlerOrderLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];

    openViking.state.contextResponseDelayMs = 120;
    await promptAndSettle("in-flight route preparation prompt");
    const inFlightWaitRun = await promptAndSettle("in-flight route adoption prompt");
    openViking.state.contextResponseDelayMs = 0;
    const inFlightWaitStart = inFlightWaitRun.observations.find((event) => event.type === "before_agent_start");
    const inFlightWaitReady = inFlightWaitRun.observations.find((event) => event.type === "checkpoint_refresh_complete");
    const inFlightWaitProvider = inFlightWaitRun.observations.find((event) => event.type === "before_provider_request");
    const inFlightWaitElapsedMs = inFlightWaitStart && inFlightWaitProvider
      ? Date.parse(inFlightWaitProvider.at) - Date.parse(inFlightWaitStart.at)
      : Number.POSITIVE_INFINITY;
    const runtimeRevocationRun = await promptAndSettle("runtime process revocation probe");

    const observations = readObservations(observationLog);
    const treeEvents = observations.filter((event) => event.type === "session_tree");
    const compactionEvents = observations.filter((event) => event.type === "session_compact");
    const compactionRequests = observations.filter((event) => event.type === "session_before_compact");
    const sessionStarts = observations.filter((event) => event.type === "session_start");
    const sessionShutdowns = observations.filter((event) => event.type === "session_shutdown");
    const lifecycleProviderRequests = observations.filter((event) => event.type === "before_provider_request");
    const constructedOutputs = observations.filter((event) => event.type === "context_allowed");
    const hookVerified = lifecycleProviderRequests.filter((event) => event.hookOutcome === "verified" && event.nonce);
    const hookRejected = lifecycleProviderRequests.filter((event) => event.hookOutcome === "rejected" && event.nonce);
    const hookUnobserved = observations.filter((event) => event.type === "constructed_output_unobserved" && event.nonce);
    const outcomeNonces = [hookVerified, hookRejected, hookUnobserved].map((events) => new Set(events.map((event) => event.nonce)));
    const hookOutcomeAccounting = constructedOutputs.length > 0
      && new Set(constructedOutputs.map((event) => event.nonce)).size === constructedOutputs.length
      && hookVerified.length + hookRejected.length + hookUnobserved.length === constructedOutputs.length
      && outcomeNonces.every((nonces, index) => outcomeNonces.every((other, otherIndex) => index === otherIndex
        || [...nonces].every((nonce) => !other.has(nonce))));

    const transportRecords = provider.state.payloads.map((payload, index) => ({
      hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      receivedAt: provider.state.receivedAt[index],
    }));
    const transportPartitions = { adopted: 0, changed: 0, unobserved: 0 };
    for (let index = 0; index < hookVerified.length; index += 1) {
      const request = hookVerified[index];
      if (transportRecords.some((record) => record.hash === request.payloadHash)) {
        transportPartitions.adopted += 1;
        continue;
      }
      const startedAt = Date.parse(request.at);
      const endedAt = Date.parse(hookVerified[index + 1]?.at ?? "9999-12-31T23:59:59.999Z");
      if (transportRecords.some((record) => record.receivedAt >= startedAt && record.receivedAt < endedAt)) {
        transportPartitions.changed += 1;
      } else {
        transportPartitions.unobserved += 1;
      }
    }
    const transportObservedIndependently = transportPartitions.adopted > 0
      && Object.values(transportPartitions).reduce((total, count) => total + count, 0) === hookVerified.length;

    const statusEvents = client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus");
    const statusTexts = statusEvents.map((event) => event.statusText);
    const uiProviderStateConsistent = hookVerified.every((requestEvent) => {
      const matchedIndex = transportRecords.findIndex((record) => record.hash === requestEvent.payloadHash);
      if (matchedIndex < 0) return false;
      const receivedAt = transportRecords[matchedIndex].receivedAt;
      return statusEvents.filter((event) => event._receivedAt <= receivedAt).at(-1)?.statusText === MEMORY_STATUS.active;
    });
    const memoryStatusLifecycle = statusTexts[0] === MEMORY_STATUS.initializing
      && statusTexts.includes(MEMORY_STATUS.active)
      && statusTexts.includes(MEMORY_STATUS.faulted)
      && statusTexts.every((status) => status === undefined || enhancementStatuses.has(status));
    const checkpointRefreshErrors = observations.filter((event) => event.type === "checkpoint_refresh_error");
    const expectedBackendFailure = checkpointRefreshErrors
      .filter((event) => event.error === "OpenViking HTTP 503: controlled context failure").length >= 1;
    const lifecycle = {
      treeRoundTrip: plainToBranchPoint.newLeafId === branchPointId
        && plainToA.newLeafId === originalLeafId
        && summaryToB.newLeafId === branchBLeafId
        && returnToA.newLeafId === originalLeafId,
      treeSummarySuppression: plainToA.summaryEntryId === undefined
        && summaryToB.summaryEntryId === undefined
        && summaryProviderRequests === 0
        && observations.some((event) => event.type === "session_tree"
          && event.requestedDecision === "empty-summary"
          && event.hostBehavior === "observed"),
      treeHostMismatchDiagnosed: Boolean(nativeSummaryToB.summaryEntryId)
        && nativeSummaryProviderRequests === 1
        && nativeSummaryObservations.some((event) => event.type === "host_behavior_unverified"
          && event.boundary === "tree-summary")
        && nativeSummaryObservations.some((event) => event.type === "session_tree"
          && event.hostBehavior === "unverified"),
      treeHandlerOrderObserved: handlerOrder.some((event) => event.event === "session_before_tree")
        && !handlerOrder.some((event) => event.event === "session_before_compact"),
      treeCancellationState: canceledTreeStatusStable,
      rootNavigation: rootNavigation.newLeafId === userEntries[0].parentId
        && rootRun.observations.some((event) => event.type === "context_allowed")
        && rootRun.payloads.length === 1,
      treeProviderAdoption: requestAdoptedFor(plainARun, plainAState)
        && requestAdoptedFor(summaryBRun, summaryBState)
        && requestAdoptedFor(returnARun, returnAState)
        && !JSON.stringify(plainARun.payloads).includes("conflicting branch B lifecycle prompt")
        && !JSON.stringify(returnARun.payloads).includes("conflicting branch B lifecycle prompt"),
      replacements: forkState.sessionId !== originalState.sessionId
        && cloneState.sessionId !== originalState.sessionId
        && cloneState.sessionId !== forkState.sessionId
        && sessionStarts.filter((event) => event.reason === "fork").length >= 2
        && sessionStarts.filter((event) => event.reason === "resume").length >= 2,
      replacementProviderAdoption: requestAdoptedFor(forkRun, forkReadyState)
        && requestAdoptedFor(resumedRun, { ...resumedState, leafId: resumedLeafId })
        && requestAdoptedFor(cloneRun, cloneReadyState)
        && requestAdoptedFor(cloneResumeRun, { ...cloneResumeState, leafId: cloneResumeLeafId }),
      reload: sessionStarts.some((event) => event.reason === "reload")
        && sessionShutdowns.some((event) => event.reason === "reload")
        && requestAdoptedFor(reloadRun, { ...reloadedState, leafId: reloadedLeafId }),
      compactionSuppression: manualSuppressed
        && thresholdSuppressed
        && overflowSuppressed
        && ["manual", "threshold", "overflow"].every((reason) =>
          compactionRequests.some((event) => event.reason === reason && event.decision === "cancel"))
        && compactionEvents.length === 0
        && compactionEntriesAfter === compactionEntriesBefore,
      overflowRetrySuppressed: overflowSuppressed,
      compactionContinuationAdopted: requestAdoptedFor(manualAdoptionRun, { ...manualState, leafId: manualLeafId })
        && requestAdoptedFor(thresholdAdoptionRun, { ...thresholdState, leafId: thresholdLeafId })
        && requestAdoptedFor(overflowAdoptionRun, { ...overflowState, leafId: overflowLeafId }),
      backgroundRefreshFailureRetainsAuthorization: backendNativeRun.observations.some((event) =>
        event.type === "before_provider_request"
        && event.hookOutcome === "verified"
        && backendNativeRun.payloads.some((payload) => createHash("sha256")
          .update(JSON.stringify(payload)).digest("hex") === event.payloadHash))
        && !observations.slice(backendFailureOffset, archiveFailureOffset).some((event) =>
          event.type === "generation_fault_latched" && event.stage === "working-context")
        && expectedBackendFailure,
      archiveRecovery: archiveBlockedRun.observations.some((event) => event.type === "context_blocked")
        && archiveBlockedRun.payloads.length === 0
        && observations.slice(archiveFailureOffset).some((event) =>
          event.type === "generation_fault_latched" && event.fault === "source-barrier")
        && observations.slice(archiveFailureOffset).some((event) => event.type === "generation_fault_replaced")
        && requestAdoptedFor(archiveRecoveredRun, archiveRecoveryReadyState),
      providerStateConsistent: uiProviderStateConsistent && hookOutcomeAccounting && transportObservedIndependently,
      memoryStatusLifecycle,
      eventCounts: {
        tree: treeEvents.length,
        compactionRequests: compactionRequests.length,
        compactionEntries: compactionEvents.length,
        hostBehaviorUnverified: observations.filter((event) => event.type === "host_behavior_unverified").length,
        starts: sessionStarts.length,
        shutdowns: sessionShutdowns.length,
        providerRequests: lifecycleProviderRequests.length,
      },
    };
    const fourthRequest = fourthRun.observations.find((event) => event.type === "before_provider_request");
    const fourthPayload = fourthRun.payloads.find((payload) => createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex") === fourthRequest?.payloadHash);
    const providerMessages = Array.isArray(fourthPayload?.messages) ? fourthPayload.messages : [];
    const priorPromptMessages = providerMessages.filter((message) => [
      "first persisted prompt # Enhanced session context",
      "second mismatched-runtime prompt",
      "third route preparation prompt",
    ].includes(message.content));
    const runHasVerifiedTransport = (run) => run.observations.some((event) =>
      event.type === "before_provider_request"
      && event.hookOutcome === "verified"
      && event.contextAuthorization === "allowed"
      && run.payloads.some((payload) => createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex") === event.payloadHash));
    const inFlightReadyIndex = inFlightWaitRun.observations.indexOf(inFlightWaitReady);
    const inFlightProviderIndex = inFlightWaitRun.observations.indexOf(inFlightWaitProvider);
    return {
      hookVerifiedAndTransportAdopted: fourthRequest?.hookOutcome === "verified"
        && fourthRequest.contextAuthorization === "allowed"
        && Boolean(fourthPayload)
        && JSON.stringify(fourthPayload).includes("# Enhanced session context")
        && JSON.stringify(fourthPayload).includes("fourth current prompt"),
      spoofedMarkerCannotAuthorize: spoofedMarkerObservations.some((event) =>
        event.type === "before_provider_request" && event.hookOutcome === "verified")
        && spoofedMarkerObservations.some((event) => event.type === "context_allowed" && typeof event.nonce === "string")
        && spoofedMarkerTransportCount === 1,
      inFlightContextWaitAdopted: inFlightWaitProvider?.hookOutcome === "verified"
        && inFlightWaitProvider?.contextAuthorization === "allowed"
        && inFlightProviderIndex >= 0
        && (inFlightReadyIndex < 0 || inFlightProviderIndex < inFlightReadyIndex)
        && inFlightWaitElapsedMs < 2_000
        && runHasVerifiedTransport(inFlightWaitRun),
      runtimeRevocationAtHookBlocked: runtimeRevocationRun.payloads.length === 0
        && runtimeRevocationRun.observations.some((event) => event.type === "before_provider_request"
          && event.hookOutcome === "rejected"
          && event.rejectionReason === "Memory runtime capability is unavailable"),
      desiredConfigDoesNotDisableRuntime: runHasVerifiedTransport(desiredMismatchRun)
        && runHasVerifiedTransport(stableRuntimeRun),
      hookOutcomeAccounting,
      transportObservedIndependently,
      transportPartitions,
      currentTurnOnly: priorPromptMessages.length === 0,
      lifecycle,
      providerRequests: provider.state.payloads.length,
      observations,
      payloads: provider.state.payloads,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`);
  } finally {
    await client.close();
    await provider.close();
    writeJson(join(caseDir, "rpc-events.json"), client.events);
    writeJson(join(caseDir, "provider-payloads.json"), provider.state.payloads);
    writeJson(join(caseDir, "provider-received-at.json"), provider.state.receivedAt);
    writeFileSync(join(caseDir, "pi-stderr.log"), Buffer.concat(stderr));
    if (existsSync(observationLog)) writeFileSync(join(caseDir, "observations-copy.jsonl"), readFileSync(observationLog));
  }
}

async function runPiFooterCase(openViking) {
  const caseDir = join(artifactRoot, "pi-footer");
  const home = join(caseDir, "home");
  const agentDir = join(caseDir, "pi-agent");
  const runtimeDir = join(caseDir, "runtime");
  const sessionDir = join(caseDir, "session");
  const observationLog = join(caseDir, "observations.jsonl");
  const settingsPath = join(caseDir, "memory-model.jsonc");
  const settingsTargetDir = join(caseDir, "memory-model-target");
  const settingsTargetPath = join(settingsTargetDir, "memory-model.jsonc");
  const providerPath = join(caseDir, "local-provider.ts");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(settingsTargetDir, { recursive: true });
  const memorySetting = {
    provider: suite.models.memoryProvider,
    model: suite.models.memoryRoute,
    api_key: "local-validation",
  };
  const settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(memorySetting).sort(([left], [right]) => left.localeCompare(right)))))
    .digest("hex");
  const compiledMemoryConfig = await compileOpenVikingConfig(root, memorySetting, { ...process.env, HOME: home });
  writeFileSync(settingsTargetPath, `${JSON.stringify({ memoryModel: memorySetting })}\n`, "utf8");
  symlinkSync(settingsTargetPath, settingsPath);
  const launchId = `context-footer-${process.pid}`;
  writeJson(join(runtimeDir, "launcher.lock"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
  });
  writeJson(join(runtimeDir, "launcher.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    controlUrl: "http://127.0.0.1:1",
    operationTimeoutMs: 30_000,
  });
  writeJson(join(runtimeDir, "state.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    childPid: process.pid,
    phase: "ready",
    ready: true,
    serviceReady: true,
    requestReady: true,
    activeProvider: memorySetting.provider,
    activeModel: memorySetting.model,
    activeSettingsFingerprint: settingsFingerprint,
    activeConfigFingerprint: compiledMemoryConfig.configFingerprint,
    activeProfile: compiledMemoryConfig.profile,
    activeProfileFingerprint: compiledMemoryConfig.profileFingerprint,
    memoryCapability: controlledCapabilityProof(launchId, settingsFingerprint, compiledMemoryConfig),
    targetProvider: memorySetting.provider,
    targetModel: memorySetting.model,
    targetSettingsFingerprint: settingsFingerprint,
    targetConfigFingerprint: compiledMemoryConfig.configFingerprint,
    targetProfileFingerprint: compiledMemoryConfig.profileFingerprint,
  });
  const provider = await startLocalProvider();
  writeFileSync(providerPath, `export default function localProvider(pi) {
  pi.registerProvider("context-footer-validation", {
    name: "Context Footer Validation",
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"], cost: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 256 }],
  });
}\n`, "utf8");
  const expectPath = spawnSync("which", ["expect"], { encoding: "utf8" }).stdout.trim();
  assert(expectPath, "Interactive footer validation requires an expect-compatible PTY driver");
  const tclWord = (value) => `{${value.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;
  const piArgs = [
    "pi", "--approve",
    "--session-dir", sessionDir,
    "--model", "context-footer-validation/local",
    "--thinking", "off",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-tools",
    "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
    "--extension", providerPath,
  ];
  const expectProgram = [
    "set timeout 30",
    `spawn -noecho ${piArgs.map(tclWord).join(" ")}`,
    "expect -re {context-footer-validation}",
    "send -- \"interactive footer task response probe\\r\"",
    "expect -re {local response}",
    "send -- \"\\004\"",
    "expect eof",
  ].join("\n");
  const child = spawn(expectPath, ["-c", expectProgram], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_MEMORY_MODEL_SETTINGS: settingsPath,
      PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
      PCR_OPENVIKING_URL: openViking.baseUrl,
      PCR_CHECKPOINT_COMMIT_PENDING_TOKENS: "1",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: join(caseDir, "archive"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));
  try {
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "footer_rendered"),
      "interactive footer installation",
      30_000,
    );
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "agent_settled"),
      "interactive footer task settlement",
      30_000,
    );
    const rendered = await waitFor(
      () => readObservations(observationLog)
        .filter((event) => event.type === "footer_rendered")
        .findLast((event) => event.snapshot?.usage?.input > 0 && event.snapshot?.context?.tokens !== null),
      "interactive footer usage refresh",
      30_000,
    );
    await waitFor(
      () => readObservations(observationLog).some((event) => event.type === "footer_adapter" && event.action === "uninstalled"),
      "interactive footer uninstall",
      30_000,
    );
    const expectedBranchResult = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
    assert(expectedBranchResult.status === 0, `Cannot read validation Git branch: ${expectedBranchResult.stderr}`);
    const expectedGitBranch = expectedBranchResult.stdout.trim() || "detached";
    const observations = readObservations(observationLog);
    return {
      installed: observations.some((event) => event.type === "footer_adapter" && event.action === "installed" && event.mode === "tui"),
      uninstalled: observations.some((event) => event.type === "footer_adapter" && event.action === "uninstalled" && event.mode === "tui"),
      model: rendered.snapshot.model === "local" && rendered.snapshot.provider === "context-footer-validation",
      usage: rendered.snapshot.usage.input === provider.state.promptTokens
        && rendered.snapshot.usage.output > 0
        && rendered.snapshot.usage.cost > 0,
      context: rendered.snapshot.context.contextWindow === 16_384
        && rendered.snapshot.context.tokens >= provider.state.promptTokens
        && rendered.snapshot.context.percent > 0,
      branch: rendered.snapshot.gitBranch === expectedGitBranch,
      marker: Buffer.concat(output).toString("utf8").includes("(增强)"),
      authorizationIndependent: observations.some((event) => event.type === "before_provider_request"
        && event.hookOutcome === "verified" && event.contextAuthorization === "allowed"),
    };
  } finally {
    try {
      await waitForExit(child, 2_000);
    } catch {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      await waitForExit(child);
    }
    await provider.close();
    writeFileSync(join(caseDir, "tui-output.log"), Buffer.concat(output));
    if (existsSync(observationLog)) writeFileSync(join(caseDir, "observations-copy.jsonl"), readFileSync(observationLog));
  }
}

async function runPiCurrentTurnCase(openViking) {
  const caseDir = join(artifactRoot, "pi-current-turn");
  const home = join(caseDir, "home");
  const agentDir = join(caseDir, "pi-agent");
  const runtimeDir = join(caseDir, "runtime");
  const observationLog = join(caseDir, "observations.jsonl");
  const archiveRoot = join(caseDir, "archive");
  const settingsPath = join(caseDir, "memory-model.jsonc");
  const providerPath = join(caseDir, "local-provider.ts");
  const toolsPath = join(caseDir, "current-turn-tools.ts");
  const payloadMutationPath = join(caseDir, "payload-mutation.ts");
  const fullOutputPath = join(caseDir, "current-turn-full-output.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const memorySetting = {
    provider: suite.models.memoryProvider,
    model: suite.models.memoryRoute,
    api_key: "local-validation",
  };
  const settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(memorySetting).sort(([left], [right]) => left.localeCompare(right)))))
    .digest("hex");
  const compiledMemoryConfig = await compileOpenVikingConfig(root, memorySetting, { ...process.env, HOME: home });
  writeFileSync(settingsPath, `${JSON.stringify({ memoryModel: memorySetting })}\n`, "utf8");
  const launchId = `context-current-turn-${process.pid}`;
  writeJson(join(runtimeDir, "launcher.lock"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
  });
  writeJson(join(runtimeDir, "launcher.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    controlUrl: "http://127.0.0.1:1",
    operationTimeoutMs: 30_000,
  });
  writeJson(join(runtimeDir, "state.json"), {
    schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
    launchId,
    launcherPid: process.pid,
    childPid: process.pid,
    phase: "ready",
    ready: true,
    serviceReady: true,
    requestReady: true,
    activeProvider: memorySetting.provider,
    activeModel: memorySetting.model,
    activeSettingsFingerprint: settingsFingerprint,
    activeConfigFingerprint: compiledMemoryConfig.configFingerprint,
    activeProfile: compiledMemoryConfig.profile,
    activeProfileFingerprint: compiledMemoryConfig.profileFingerprint,
    memoryCapability: controlledCapabilityProof(launchId, settingsFingerprint, compiledMemoryConfig),
    targetProvider: memorySetting.provider,
    targetModel: memorySetting.model,
    targetSettingsFingerprint: settingsFingerprint,
    targetConfigFingerprint: compiledMemoryConfig.configFingerprint,
    targetProfileFingerprint: compiledMemoryConfig.profileFingerprint,
  });

  const provider = await startLocalProvider();
  writeFileSync(providerPath, `export default function localProvider(pi) {
  pi.registerProvider("context-enhancement-validation", {
    name: "Context Enhancement Validation",
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 256 }],
  });
}\n`, "utf8");

  writeFileSync(payloadMutationPath, `export default function payloadMutation(pi) {
  pi.on("context", (event) => {
    if (!JSON.stringify(event.messages).includes("current-turn source mutation probe")
      || !event.messages.some((message) => message.role === "toolResult")) return;
    let changed = false;
    return { messages: event.messages.map((message) => {
      if (changed || message.role !== "toolResult") return message;
      changed = true;
      return { ...message, content: [{ type: "text", text: "M".repeat(200000) }] };
    }) };
  });
  pi.on("before_provider_request", (event) => {
    if (!JSON.stringify(event.payload).includes("current-turn profile mutation probe")) return;
    const payload = event.payload;
    return {
      ...payload,
      messages: payload.messages.map((message) => message.role === "system"
        ? { ...message, content: message.content + " mutated" }
        : message),
      tools: [...(payload.tools ?? []), { type: "function", function: { name: "mutated", description: "mutated", parameters: { type: "object" }, strict: false } }],
      max_completion_tokens: (payload.max_completion_tokens ?? 0) + 1,
    };
  });
}\n`, "utf8");
  writeFileSync(toolsPath, `import { writeFileSync } from "node:fs";
const parameters = { type: "object", properties: {}, additionalProperties: false };
export default function currentTurnTools(pi) {
  pi.registerTool({ name: "validation_small", label: "Validation small", description: "Return a small controlled result", parameters,
    execute: async () => ({ content: [{ type: "text", text: "small controlled result" }], details: {} }) });
  pi.registerTool({ name: "validation_large", label: "Validation large", description: "Return a 200000 character controlled result", parameters,
    execute: async () => ({ content: [{ type: "text", text: "L".repeat(200000) }], details: {} }) });
  pi.registerTool({ name: "validation_full", label: "Validation full", description: "Return a truncated result backed by fullOutputPath", parameters,
    execute: async () => {
      writeFileSync(${JSON.stringify(fullOutputPath)}, "full:" + "F".repeat(210000), "utf8");
      return { content: [{ type: "text", text: "truncated full output at ${fullOutputPath}" }], details: { fullOutputPath: ${JSON.stringify(fullOutputPath)} } };
    } });
  pi.registerTool({ name: "validation_error", label: "Validation error", description: "Return a controlled tool error", parameters,
    execute: async () => ({ content: [{ type: "text", text: "controlled tool error" }], details: {}, isError: true }) });
}\n`, "utf8");

  const child = spawn("pi", [
    "--mode", "rpc",
    "--session-dir", join(caseDir, "session"),
    "--model", "context-enhancement-validation/local",
    "--thinking", "off",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions",
    "--extension", payloadMutationPath,
    "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
    "--extension", providerPath,
    "--extension", toolsPath,
  ], {
    cwd: root,
    env: {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_MEMORY_MODEL_SETTINGS: settingsPath,
      PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
      PCR_OPENVIKING_URL: openViking.baseUrl,
      PCR_CHECKPOINT_COMMIT_PENDING_TOKENS: "1",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: archiveRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new RpcClient(child);
  const promptAndSettle = async (message) => {
    const observationOffset = readObservations(observationLog).length;
    const providerOffset = provider.state.payloads.length;
    const settledBefore = readObservations(observationLog).filter((event) => event.type === "agent_settled").length;
    await client.send("prompt", { message });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length > settledBefore,
      `current-turn settlement for ${message}`,
      30_000,
    );
    return {
      observations: readObservations(observationLog).slice(observationOffset),
      payloads: provider.state.payloads.slice(providerOffset),
    };
  };
  try {
    await waitFor(() => client.events.some((event) => event.type === "extension_ui_request" && event.method === "setStatus"), "current-turn Pi startup");
    await promptAndSettle("current-turn warmup");
    await waitFor(() => readObservations(observationLog).some((event) => event.type === "checkpoint_refresh_complete"), "current-turn checkpoint refresh", 10_000);
    const rawRun = await promptAndSettle("current-turn raw tool probe");
    const projectedRun = await promptAndSettle("current-turn projected tool probe");
    const profileMutationRun = await promptAndSettle("current-turn profile mutation probe");
    const readyBeforeReplacement = readObservations(observationLog)
      .filter((event) => event.type === "checkpoint_refresh_complete").length;
    await client.send("new_session");
    await promptAndSettle("current-turn replacement warmup");
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "checkpoint_refresh_complete").length > readyBeforeReplacement,
      "current-turn replacement checkpoint refresh",
      10_000,
    );
    const sourceMutationRun = await promptAndSettle("current-turn source mutation probe");
    const rawContext = rawRun.observations.find((event) =>
      event.type === "context_allowed" && event.currentTurn?.rawToolBatches === 1);
    const projectedContext = projectedRun.observations.find((event) =>
      event.type === "context_allowed" && event.currentTurn?.projectedToolBatches === 1);
    const rawPayload = rawRun.payloads.at(-1);
    const projectedPayload = projectedRun.payloads.at(-1);
    const projectedMessages = Array.isArray(projectedPayload?.messages) ? projectedPayload.messages : [];
    const callIds = projectedMessages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => call.id)
        : []);
    const resultIds = projectedMessages.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
    const projectedRecords = projectedContext?.currentTurn?.projectedSourceEntryIds?.map((entryId) => JSON.parse(readFileSync(join(
      archiveRoot,
      createHash("sha256").update(projectedContext.sessionId).digest("hex"),
      "sources",
      `${createHash("sha256").update(entryId).digest("hex")}.json`,
    ), "utf8"))) ?? [];
    const largeRecord = projectedRecords.find((record) => JSON.stringify(record.projection?.taskContent).includes("L".repeat(1_000)));
    const fullRecord = projectedRecords.find((record) => record.fullOutputRef);
    rmSync(fullOutputPath, { force: true });
    const fullBlob = fullRecord ? readFileSync(join(
      archiveRoot,
      createHash("sha256").update(projectedContext.sessionId).digest("hex"),
      "large-results",
      "blobs",
      fullRecord.fullOutputRef.blobId,
    ), "utf8") : undefined;
    const transportAdopted = (run, context) => run.observations.some((event) =>
      event.type === "before_provider_request"
      && event.hookOutcome === "verified"
      && event.nonce === context?.nonce
      && run.payloads.some((payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex") === event.payloadHash));
    return {
      raw: Boolean(rawContext)
        && JSON.stringify(rawPayload).includes("small controlled result")
        && JSON.stringify(rawPayload).includes("controlled tool error")
        && !JSON.stringify(rawPayload).includes("pi-context-memory projected tool result"),
      projected: Boolean(projectedContext)
        && JSON.stringify(projectedPayload).includes("pi-context-memory projected tool result")
        && JSON.stringify(projectedPayload).includes("isError")
        && !JSON.stringify(projectedPayload).includes(fullOutputPath)
        && !JSON.stringify(projectedPayload).includes("L".repeat(1_000))
        && Buffer.byteLength(JSON.stringify(projectedPayload), "utf8") < 32_768,
      protocolComplete: callIds.length === 3 && JSON.stringify(resultIds) === JSON.stringify(callIds),
      sourcesRecoverable: Boolean(largeRecord) && fullBlob === `full:${"F".repeat(210_000)}`,
      transportAdopted: transportAdopted(rawRun, rawContext) && transportAdopted(projectedRun, projectedContext),
      profileMutationBlocked: profileMutationRun.payloads.length === 0
        && profileMutationRun.observations.some((event) => event.type === "before_provider_request"
          && event.hookOutcome === "rejected"
          && event.rejectionReason === "handler payload does not match the constructed Provider payload profile"),
      sourceMutationBlocked: sourceMutationRun.observations
        .filter((event) => event.type === "before_provider_request" && event.hookOutcome === "verified").length === 1
        && sourceMutationRun.observations.some((event) => event.type === "context_blocked"
          && event.fault === "source-barrier")
        && !sourceMutationRun.payloads.some((payload) => JSON.stringify(payload).includes("M".repeat(1_000))),
      rawMetrics: rawContext?.currentTurn,
      projectedMetrics: projectedContext?.currentTurn,
      projectedPayloadBytes: Buffer.byteLength(JSON.stringify(projectedPayload), "utf8"),
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`);
  } finally {
    await client.close();
    await provider.close();
    writeJson(join(caseDir, "rpc-events.json"), client.events);
    writeJson(join(caseDir, "provider-payloads.json"), provider.state.payloads);
    writeFileSync(join(caseDir, "pi-stderr.log"), Buffer.concat(stderr));
    if (existsSync(observationLog)) writeFileSync(join(caseDir, "observations-copy.jsonl"), readFileSync(observationLog));
  }
}

async function runAuthorizationBlockCase() {
  const caseDir = join(artifactRoot, "authorization-block");
  const home = join(caseDir, "home");
  const agentDir = join(caseDir, "pi-agent");
  const observationLog = join(caseDir, "observations.jsonl");
  const providerPath = join(caseDir, "local-provider.ts");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const provider = await startLocalProvider();
  writeFileSync(providerPath, `export default function localProvider(pi) {
  pi.registerProvider("context-enhancement-block", {
    name: "Context Enhancement Block",
    baseUrl: ${JSON.stringify(provider.baseUrl)},
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
  });
}\n`, "utf8");
  const child = spawn("pi", [
    "--mode", "rpc",
    "--session-dir", join(caseDir, "session"),
    "--model", "context-enhancement-block/local",
    "--thinking", "off",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-tools",
    "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
    "--extension", providerPath,
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: join(caseDir, "archive"),
      PCR_OPENVIKING_URL: "http://127.0.0.1:1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new RpcClient(child);
  try {
    await waitFor(() => client.events.some((event) => event.type === "extension_ui_request" && event.method === "setStatus"), "block-case Pi startup");
    await client.send("prompt", { message: "authorization block probe" });
    await waitFor(() => readObservations(observationLog).some((event) => event.type === "agent_settled"), "authorization block settlement");
    const observations = readObservations(observationLog);
    const blockIndex = observations.findLastIndex((event) => event.type === "context_blocked");
    const settledIndex = observations.findIndex((event, index) => index > blockIndex && event.type === "agent_settled");
    const extensionContinuedAfterBlock = blockIndex < 0 ? Number.POSITIVE_INFINITY : observations
      .slice(blockIndex + 1, settledIndex < 0 ? undefined : settledIndex)
      .filter((event) => event.type === "context_allowed"
        || (event.type === "before_provider_request" && event.hookOutcome === "verified"))
      .length;
    const blocked = observations.filter((event) => event.type === "context_blocked");
    return {
      contextBlockStopsExtension: blocked.length === 1
        && extensionContinuedAfterBlock === 0
        && !Object.hasOwn(blocked[0], "messages")
        && !Object.hasOwn(blocked[0], "adoptedMessages"),
      transportObservedIndependently: provider.state.payloads.length === 0,
      extensionContinuedAfterBlock,
      transportRequestCount: provider.state.payloads.length,
      blockFaults: blocked.map((event) => event.fault),
      statusTexts: [...new Set(client.events
        .filter((event) => event.type === "extension_ui_request" && event.method === "setStatus")
        .map((event) => event.statusText))],
    };
  } finally {
    await client.close();
    await provider.close();
    writeJson(join(caseDir, "rpc-events.json"), client.events);
    writeJson(join(caseDir, "provider-payloads.json"), provider.state.payloads);
    writeFileSync(join(caseDir, "pi-stderr.log"), Buffer.concat(stderr));
    if (existsSync(observationLog)) writeFileSync(join(caseDir, "observations-copy.jsonl"), readFileSync(observationLog));
  }
}

const checks = {};
const details = {};
let openViking;
try {
  checks.sharedFixtureLoaded = fixture.schemaVersion === 1
    && fixture.task?.checker?.requiredDecision === "bounded-current-route"
    && fixture.task?.checker?.requiredEvidenceEntryId === "b000000c";
  assert(checks.sharedFixtureLoaded, "Shared long-task fixture is invalid");
  checks.workingMemoryTaskDeadlineBounded = DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS === 180_000;
  const structuredOverview = [
    "# Working Memory",
    "## Session Title",
    "## Current State",
    "## Task & Goals",
    "## Key Facts & Decisions",
    "## Files & Context",
    "## Errors & Corrections",
    "## Open Issues",
    "The active route remains bounded to verified Pi source identifiers and rejects any stale or unverifiable upstream context before adoption.",
  ].join("\n");
  const localizedOverview = structuredOverview
    .replace("## Session Title", "## 会话标题")
    .replace("## Current State", "## 当前状态");
  const normalizedContext = normalizeSessionContext({
    latest_archive_overview: localizedOverview,
    messages: [{ role: "user", parts: [{ type: "text", text: "active route" }], source_message_ids: ["b000000c"] }],
  });
  let genericFallbackRejected = false;
  let malformedContextRejected = false;
  let missingSourceIdsRejected = false;
  let unknownContentShapeRejected = false;
  let localizedOverviewOnlyRejected = false;
  try {
    normalizeSessionContext({ latest_archive_overview: "# Session Summary\n\n**Overview**: 10 turns, 20 messages", messages: [] });
  } catch {
    genericFallbackRejected = true;
  }
  try {
    normalizeSessionContext({ latest_archive_overview: localizedOverview, messages: [{ parts: [], source_message_ids: [42] }] });
  } catch {
    malformedContextRejected = true;
  }
  try {
    normalizeSessionContext({
      latest_archive_overview: localizedOverview,
      messages: [{ role: "user", parts: [{ type: "text", text: "unverified" }] }],
    });
  } catch {
    missingSourceIdsRejected = true;
  }
  try {
    normalizeSessionContext({
      latest_archive_overview: localizedOverview,
      messages: [{ role: "user", content: [{ type: "text", text: "unknown" }], source_message_ids: ["b000000c"] }],
    });
  } catch {
    unknownContentShapeRejected = true;
  }
  try {
    normalizeSessionContext({ latest_archive_overview: "# 会话摘要\n\n10 轮，20 条消息", messages: [] });
  } catch {
    localizedOverviewOnlyRejected = true;
  }
  checks.workingContextResponseNormalized = normalizedContext.overview === localizedOverview
    && normalizedContext.messages[0]?.text === "active route"
    && normalizedContext.messages[0]?.sourceMessageIds[0] === "b000000c"
    && Number.isFinite(normalizedContext.estimatedTokens)
    && genericFallbackRejected
    && malformedContextRejected
    && missingSourceIdsRejected
    && unknownContentShapeRejected
    && localizedOverviewOnlyRejected;

  const incompatiblePiEntries = [
    {
      type: "message",
      id: "pi-unknown-block",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "input_text", text: "must not disappear" }] },
    },
    {
      type: "message",
      id: "pi-unknown-role",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "future-role", content: "must not disappear" },
    },
    {
      type: "compaction",
      id: "pi-malformed-compaction",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "summary without a retained boundary",
    },
  ];
  // 目标契约：当前未知 role/block 由 Pi 的 convertToLlm 丢弃，不形成来源，也不抛错；
  // Pi 仍可见的内容不得被本扩展静默删除，因此保留在 Provider 基线中。
  checks.piProtocolUnknownDropped = incompatiblePiEntries.every((entry) => {
    const { projections, providerBaseline } = projectRoute(profile, [entry], entry.id);
    const archivable = projections.filter((projection) => projection.kind === "message-source");
    if (archivable.length > 0) return false;
    if (entry.type === "compaction") {
      return projections.some((projection) => projection.kind === "control-boundary")
        && !JSON.stringify(projections).includes("summary without a retained boundary");
    }
    const opaque = projections.filter((projection) => projection.kind === "opaque-provider-segment");
    return providerBaseline.length === 0 ? opaque.length === 0 : opaque.length === 1;
  });
  const common = routeEntries("common");
  const branchA = routeEntries("branchA");
  const branchB = routeEntries("branchB");
  const afterCompaction = routeEntries("afterCompaction");
  const commonProjections = projectRoute(profile, common, common.at(-1)?.id ?? null).projections;
  const branchAProjections = projectRoute(profile, branchA, branchA.at(-1)?.id ?? null).projections;
  const branchBProjections = projectRoute(profile, branchB, branchB.at(-1)?.id ?? null).projections;
  const compactedProjections = projectRoute(
    profile,
    afterCompaction,
    afterCompaction.at(-1)?.id ?? null,
  ).projections;
  const identity = {
    sessionId: "context-enhancement-session",
    sessionFile: join(artifactRoot, "session.jsonl"),
  };
  const coordinator = new SessionMemoryCoordinator(identity, new FileLongTermMemory(join(artifactRoot, "archive")), profile);
  const commonRoute = coordinator.identifyCurrentRoute(snapshot(identity, common));
  const routeA = coordinator.identifyCurrentRoute(snapshot(identity, branchA));
  const routeB = coordinator.identifyCurrentRoute(snapshot(identity, branchB));
  const compactedRoute = coordinator.identifyCurrentRoute(snapshot(identity, afterCompaction));

  checks.currentRouteIdentity = routeA.fingerprint !== routeB.fingerprint
    && routeA.leafId === "a0000009"
    && routeB.leafId === "b000000d"
    && routeB.entryIds.at(-1) === "b000000d";

  let invalidRejected = false;
  const invalidEntries = routeEntries("common");
  invalidEntries[3].parentId = "wrong-parent";
  try {
    coordinator.identifyCurrentRoute(snapshot(identity, invalidEntries));
  } catch {
    invalidRejected = true;
  }
  checks.invalidRouteRejected = invalidRejected;
  openViking = await startOpenVikingDouble();
  const generation = "validation-generation";
  const capabilityProofId = "validation-capability-proof";
  const sessionMemory = new OpenVikingSessionMemory(openViking.baseUrl, undefined, 2_000, {
    generation,
    capabilityProofId,
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxMirrors: 6,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  const optimizer = new WorkingContextOptimizer({ maxContextChars: 1_600 });
  const providerProfile = createProviderPayloadProfile({
    provider: "validation",
    model: "local",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/validation",
    compat: null,
    contextWindowTokens: 16_384,
    maxOutputTokens: 256,
    systemPrompt: "validation",
    tools: [],
  });
  const runtimeCoordinator = new SessionMemoryCoordinator(
    identity,
    new FileLongTermMemory(join(artifactRoot, "archive")),
    profile,
    sessionMemory,
  );
  const retentionBudgetIdentity = createRetentionBudgetIdentity(
    providerProfile,
    runtimeCoordinator.checkpointRetentionPolicy(),
  );
  const emptyCheckpoint = sessionMemory.emptyCheckpoint(commonRoute, retentionBudgetIdentity);
  const opaqueOptimizer = new WorkingContextOptimizer();
  const opaqueAuthorization = await opaqueOptimizer.authorize({
    generation,
    requestRoute: commonRoute,
    historical: {
      route: commonRoute,
      checkpoint: emptyCheckpoint,
      delta: {
        checkpointIdentity: emptyCheckpoint.identity,
        projections: [],
        sourceIds: [],
        hash: sha256("opaque-delta"),
      },
      hasOpaqueSegment: true,
    },
    messages: [{ role: "user", content: "current prompt" }],
    providerPayloadProfile: providerProfile,
    toolSources: { callSources: {}, resultSources: {}, ambiguousToolIds: [] },
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => undefined,
  });
  checks.opaqueHistoryBlocks = opaqueAuthorization.kind === "block"
    && opaqueAuthorization.fault.kind === "opaque-content-unrepresentable";

  const otherIdentity = {
    sessionId: "other-context-enhancement-session",
    sessionFile: join(artifactRoot, "other-session.jsonl"),
  };
  const otherCoordinator = new SessionMemoryCoordinator(otherIdentity, new FileLongTermMemory(join(artifactRoot, "archive")), profile);
  const otherRoute = otherCoordinator.identifyCurrentRoute(snapshot(otherIdentity, branchB));
  const replacementIdentity = {
    sessionId: identity.sessionId,
    sessionFile: join(artifactRoot, "replacement-session.jsonl"),
  };
  const replacementCoordinator = new SessionMemoryCoordinator(
    replacementIdentity,
    new FileLongTermMemory(join(artifactRoot, "archive")),
    profile,
  );
  const replacementRoute = replacementCoordinator.identifyCurrentRoute(snapshot(replacementIdentity, branchB));
  checks.sessionIsolation = otherRoute.fingerprint !== routeB.fingerprint
    && replacementRoute.fingerprint !== routeB.fingerprint;

  const commonRefresh = await runtimeCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    retentionBudgetIdentity,
    { required: true },
  );
  const commonHistorical = await runtimeCoordinator.resolveHistoricalContext(
    snapshot(identity, common),
    retentionBudgetIdentity,
  );
  const commonPrepared = optimizer.prepare(commonHistorical);
  const routeARefresh = await runtimeCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchA),
    retentionBudgetIdentity,
    { required: true },
  );
  const branchBBeforeRefresh = await runtimeCoordinator.resolveHistoricalContext(
    snapshot(identity, branchB),
    retentionBudgetIdentity,
  );
  checks.lateRouteResultRejected = routeARefresh.kind === "accepted"
    && branchBBeforeRefresh.checkpoint.identity !== routeARefresh.checkpoint.identity
    && branchBBeforeRefresh.checkpoint.coveredRouteEntryIds.every((id, index) => routeB.entryIds[index] === id);
  const preparedA = optimizer.prepare(await runtimeCoordinator.resolveHistoricalContext(
    snapshot(identity, branchA),
    retentionBudgetIdentity,
  ));
  const routeBRefresh = await runtimeCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchB),
    retentionBudgetIdentity,
    { required: true },
  );
  const branchBHistorical = await runtimeCoordinator.resolveHistoricalContext(
    snapshot(identity, branchB),
    retentionBudgetIdentity,
  );
  const preparedB = optimizer.prepare(branchBHistorical);

  const otherRuntimeCoordinator = new SessionMemoryCoordinator(
    otherIdentity,
    new FileLongTermMemory(join(artifactRoot, "archive-other-runtime")),
    profile,
    sessionMemory,
  );
  const replacementRuntimeCoordinator = new SessionMemoryCoordinator(
    replacementIdentity,
    new FileLongTermMemory(join(artifactRoot, "archive-replacement-runtime")),
    profile,
    sessionMemory,
  );
  const otherRefresh = await otherRuntimeCoordinator.scheduleCheckpointRefresh(
    snapshot(otherIdentity, branchB),
    retentionBudgetIdentity,
    { required: true },
  );
  const replacementRefresh = await replacementRuntimeCoordinator.scheduleCheckpointRefresh(
    snapshot(replacementIdentity, branchB),
    retentionBudgetIdentity,
    { required: true },
  );
  const preparedOther = optimizer.prepare(await otherRuntimeCoordinator.resolveHistoricalContext(
    snapshot(otherIdentity, branchB),
    retentionBudgetIdentity,
  ));
  const preparedReplacement = optimizer.prepare(await replacementRuntimeCoordinator.resolveHistoricalContext(
    snapshot(replacementIdentity, branchB),
    retentionBudgetIdentity,
  ));
  checks.sessionIsolation &&= preparedOther.openVikingSessionId !== preparedB.openVikingSessionId
    && preparedReplacement.openVikingSessionId !== preparedB.openVikingSessionId
    && preparedReplacement.openVikingSessionId !== preparedOther.openVikingSessionId;
  const compactedRefresh = await runtimeCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, afterCompaction),
    retentionBudgetIdentity,
    { required: true },
  );
  const preparedCompacted = optimizer.prepare(await runtimeCoordinator.resolveHistoricalContext(
    snapshot(identity, afterCompaction),
    retentionBudgetIdentity,
  ));
  checks.linearRouteReused = commonPrepared.openVikingSessionId === preparedA.openVikingSessionId;
  checks.branchIsolation = preparedA.openVikingSessionId !== preparedB.openVikingSessionId
    && !openViking.state.sessions.get(preparedB.openVikingSessionId).messages
      .some((message) => message.source_message_ids?.includes("a0000009"));
  checks.workingMemoryAssembled = preparedB.hasWorkingMemory
    && preparedB.content.includes("Working memory")
    && preparedB.content.includes("b000000c");
  const boundaryCheckpoint = {
    ...(routeBRefresh.kind === "accepted" ? routeBRefresh.checkpoint : emptyCheckpoint),
    identity: "boundary-checkpoint",
    workingMemory: "O".repeat(5_000),
    activeHistory: [{ role: "user", text: "A".repeat(5_000), sourceMessageIds: ["boundary"] }],
  };
  const boundaryContext = formatWorkingContext({
    route: routeB,
    checkpoint: boundaryCheckpoint,
    delta: {
      checkpointIdentity: boundaryCheckpoint.identity,
      projections: [],
      sourceIds: [],
      hash: sha256("boundary-delta"),
    },
    hasOpaqueSegment: false,
  }, 1_600);
  checks.contextBounded = preparedB.content.length <= 1_600
    && preparedCompacted.content.length <= 1_600
    && boundaryContext.length <= 1_600
    && boundaryContext.includes("## Working memory")
    && boundaryContext.includes("## Checkpoint active history");

  const allBMessages = openViking.state.sessions.get(preparedB.openVikingSessionId).batches.flat();
  checks.sourceIdsPreserved = allBMessages.every((message) =>
    Array.isArray(message.source_message_ids)
    && message.source_message_ids.length === 1
    && fixture.entries[message.source_message_ids[0]] !== undefined
  );

  const compactedProjectionIds = projectMemorySources(compactedProjections)
    .flatMap((message) => message.source_message_ids);
  const compactedMirrorProjectionIds = openViking.state.sessions
    .get(preparedCompacted.openVikingSessionId)
    .batches.flat()
    .flatMap((message) => message.source_message_ids);
  const retainedTailCompaction = {
    type: "compaction",
    id: "retained-tail-compaction",
    parentId: common.at(-1).id,
    timestamp: "2026-08-14T09:03:00.000Z",
    summary: "retained-tail summary",
    tokensBefore: 60_000,
    retainedTail: [
      { role: "user", content: "retained-tail goal", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "retained-tail answer" }], timestamp: 2 },
    ],
  };
  const retainedTailAfter = {
    type: "message",
    id: "retained-tail-after",
    parentId: retainedTailCompaction.id,
    timestamp: "2026-08-14T09:03:01.000Z",
    message: { role: "user", content: "continue after retained tail", timestamp: 3 },
  };
  const retainedTailRoute = [...common, retainedTailCompaction, retainedTailAfter];
  const retainedTailProjections = projectRoute(profile, retainedTailRoute, retainedTailAfter.id).projections;
  // compaction 只形成无正文 ControlBoundary；summary 与 retainedTail 不进入记忆投影。
  const compactionBoundaryHasNoText = retainedTailProjections
    .filter((projection) => projection.kind === "control-boundary")
    .every((projection) => !Object.hasOwn(projection, "summary") && !Object.hasOwn(projection, "retainedTail"));
  const retainedTailTextExcluded = !JSON.stringify(
    projectMemorySources(retainedTailProjections),
  ).includes("retained-tail goal");
  checks.compactionBoundary = compactedProjectionIds.length > 0
    && preparedCompacted.openVikingSessionId !== preparedB.openVikingSessionId
    && JSON.stringify(compactedMirrorProjectionIds) === JSON.stringify(compactedProjectionIds)
    && retainedTailProjections.some((projection) => projection.kind === "control-boundary")
    && compactionBoundaryHasNoText
    && retainedTailTextExcluded;
  const summaryContamination = {
    authorityHits: SUMMARY_CONTAMINATION_SENTINELS.filter((sentinel) =>
      JSON.stringify(fixture.entries).includes(sentinel)),
    memoryProjectionHits: SUMMARY_CONTAMINATION_SENTINELS.filter((sentinel) =>
      JSON.stringify({ compactedProjections, branchBProjections }).includes(sentinel)),
    openVikingAppendHits: SUMMARY_CONTAMINATION_SENTINELS.filter((sentinel) =>
      JSON.stringify({
        compactedBatches: openViking.state.sessions.get(preparedCompacted.openVikingSessionId).batches,
        branchBBatches: openViking.state.sessions.get(preparedB.openVikingSessionId).batches,
      }).includes(sentinel)),
    workingContextHits: SUMMARY_CONTAMINATION_SENTINELS.filter((sentinel) =>
      JSON.stringify({ compacted: preparedCompacted.content, branchB: preparedB.content }).includes(sentinel)),
  };
  checks.summaryContaminationIsolated = JSON.stringify(summaryContamination.authorityHits)
      === JSON.stringify(SUMMARY_CONTAMINATION_SENTINELS)
    && summaryContamination.memoryProjectionHits.length === 0
    && summaryContamination.openVikingAppendHits.length === 0
    && summaryContamination.workingContextHits.length === 0;

  const currentTurn = [
    { role: "user", content: "old prompt", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
    { role: "user", content: "current prompt", timestamp: 3 },
    { role: "assistant", content: [{ type: "toolCall", id: "current-tool", name: "read", arguments: {} }], timestamp: 4 },
    { role: "toolResult", toolCallId: "current-tool", toolName: "read", content: [{ type: "text", text: "current evidence" }], isError: false, timestamp: 5 },
  ];
  const adopted = buildEnhancedContext(currentTurn, preparedB, "validation-nonce");
  checks.currentTurnPreserved = adopted.length === 4
    && adopted[0].role === "custom"
    && adopted[0].customType === "pi-context-memory"
    && adopted[1] === currentTurn[2]
    && adopted[2] === currentTurn[3]
    && adopted[3] === currentTurn[4];

  const largeOutputPath = join(artifactRoot, "current-turn-full-output.txt");
  const fullOutputContent = `full-output:${"F".repeat(210_000)}`;
  writeFileSync(largeOutputPath, fullOutputContent, "utf8");
  const currentTurnEntries = [
    {
      type: "message",
      id: "current-user",
      parentId: branchB.at(-1).id,
      timestamp: "2026-08-14T10:00:00.000Z",
      message: { role: "user", content: "inspect parallel tool evidence", timestamp: 10 },
    },
    {
      type: "message",
      id: "current-assistant-tools",
      parentId: "current-user",
      timestamp: "2026-08-14T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "large-call", name: "large_tool", arguments: { query: "large" } },
          { type: "toolCall", id: "full-call", name: "full_tool", arguments: { query: "full" } },
        ],
        timestamp: 11,
      },
    },
    {
      type: "message",
      id: "current-large-result",
      parentId: "current-assistant-tools",
      timestamp: "2026-08-14T10:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "large-call",
        toolName: "large_tool",
        content: [{ type: "text", text: `large:${"L".repeat(200_000)}` }],
        isError: false,
        timestamp: 12,
      },
    },
    {
      type: "message",
      id: "current-full-result",
      parentId: "current-large-result",
      timestamp: "2026-08-14T10:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "full-call",
        toolName: "full_tool",
        content: [{ type: "text", text: `truncated output at ${largeOutputPath}` }],
        details: { fullOutputPath: largeOutputPath },
        isError: true,
        truncated: true,
        timestamp: 13,
      },
    },
  ];
  const currentTurnSnapshot = snapshot(identity, [...branchB, ...currentTurnEntries]);
  const currentTurnProjection = coordinator.projectCurrentRoute(currentTurnSnapshot);
  const currentTurnSourcesById = new Map(currentTurnProjection.projections
    .filter((projection) => projection.kind === "message-source")
    .map((projection) => [projection.id, projection]));
  const currentToolSources = currentTurnToolSources(currentTurnSnapshot.entries, currentTurnSourcesById);
  const currentMessages = sanitizeFullOutputLocators(
    currentTurnEntries.map((entry) => entry.message),
    currentTurnProjection.fullOutputCandidates,
  );
  const payloadProfileInput = {
    provider: "context-enhancement-validation",
    model: "local",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/validation",
    compat: null,
    contextWindowTokens: 12_000,
    maxOutputTokens: 256,
    systemPrompt: "bounded current-turn validation",
    tools: [
      { name: "large_tool", description: "return a large result", parameters: { type: "object" } },
      { name: "full_tool", description: "return a persisted result", parameters: { type: "object" } },
    ],
  };
  const providerPayloadProfile = createProviderPayloadProfile(payloadProfileInput);
  const projectedAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: currentMessages,
    providerPayloadProfile,
    toolSources: currentToolSources,
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: (entryIds) => coordinator.ensureCurrentSourcesRecoverable(currentTurnSnapshot, entryIds),
  });
  checks.requestRouteMutationRejected = projectedAuthorization.kind === "allow"
    && assemblyRouteProofError(
      projectedAuthorization.proof,
      sha256("changed-complete-request-route"),
      branchBHistorical.route.fingerprint,
    ) === "complete request route changed after the context decision"
    && assemblyRouteProofError(
      projectedAuthorization.proof,
      projectedAuthorization.proof.requestRouteFingerprint,
      projectedAuthorization.proof.historicalRouteFingerprint,
    ) === undefined;
  const projectedProviderMessages = projectedAuthorization.kind === "allow"
    ? convertToLlm(projectedAuthorization.enhancedContext)
    : [];
  const projectedCallIds = projectedProviderMessages
    .flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
      : []);
  const projectedResultIds = projectedProviderMessages
    .filter((message) => message.role === "toolResult")
    .map((message) => message.toolCallId);
  const projectedLargeSource = await coordinator.resolveCurrentSource(currentTurnSnapshot, "current-large-result");
  rmSync(largeOutputPath);
  const recoveredFullOutput = await coordinator.readCurrentFullOutput(currentTurnSnapshot, "current-full-result", 220_000);
  checks.currentTurnProjected = projectedAuthorization.kind === "allow"
    && projectedAuthorization.metrics.projectedToolBatches === 1
    && projectedAuthorization.metrics.rawToolBatches === 0
    && projectedAuthorization.metrics.providerMessageTokenUpperBound <= providerPayloadProfile.messageTokenBudget
    && JSON.stringify(projectedProviderMessages).length < 20_000
    && !JSON.stringify(projectedProviderMessages).includes("L".repeat(1_000));
  checks.currentTurnProjectionProtocolComplete = JSON.stringify(projectedCallIds) === JSON.stringify(["large-call", "full-call"])
    && JSON.stringify(projectedResultIds) === JSON.stringify(projectedCallIds)
    && Boolean(createOpenAICompletionsPayloadProof(
      payloadProfileInput.provider,
      payloadProfileInput.model,
      projectedProviderMessages,
    ));
  checks.currentTurnProjectionSourcesRecoverable = projectedAuthorization.kind === "allow"
    && JSON.stringify(projectedAuthorization.metrics.projectedSourceEntryIds) === JSON.stringify([
      "current-assistant-tools",
      "current-large-result",
      "current-full-result",
    ])
    && JSON.stringify(projectedLargeSource?.projection.taskContent).includes("L".repeat(1_000))
    && recoveredFullOutput?.content === fullOutputContent
    && recoveredFullOutput.truncated === false;

  let rawSourceBarrierCalls = 0;
  const rawAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: [
      currentMessages[0],
      currentMessages[1],
      { ...currentMessages[2], content: [{ type: "text", text: "small result" }] },
      { ...currentMessages[3], content: [{ type: "text", text: "small error" }], details: undefined },
    ],
    providerPayloadProfile,
    toolSources: currentToolSources,
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => { rawSourceBarrierCalls += 1; },
  });
  checks.currentTurnRawPreserved = rawAuthorization.kind === "allow"
    && rawAuthorization.metrics.rawToolBatches === 1
    && rawAuthorization.metrics.projectedToolBatches === 0
    && rawSourceBarrierCalls === 0
    && JSON.stringify(convertToLlm(rawAuthorization.enhancedContext)).includes("small result");

  let oldestProjectedSources = [];
  const oldestMessages = [
    { role: "user", content: "preserve the most recent complete tool batch" },
    { role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "old_tool", arguments: {} }] },
    { role: "toolResult", toolCallId: "old-call", toolName: "old_tool", content: [{ type: "text", text: "O".repeat(12_000) }], isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "new-call", name: "new_tool", arguments: {} }] },
    { role: "toolResult", toolCallId: "new-call", toolName: "new_tool", content: [{ type: "text", text: "N".repeat(2_000) }], isError: false },
  ];
  const oldestEntries = oldestMessages.map((message, index) => ({
    type: "message",
    id: `oldest-${index}`,
    parentId: index === 0 ? null : `oldest-${index - 1}`,
    timestamp: `2026-08-14T10:01:0${index}.000Z`,
    message,
  }));
  const oldestSourcesById = new Map(projectRoute(profile, oldestEntries, oldestEntries.at(-1).id).projections
    .filter((projection) => projection.kind === "message-source")
    .map((projection) => [projection.id, projection]));
  const oldestFirstAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: oldestMessages,
    providerPayloadProfile,
    toolSources: currentTurnToolSources(oldestEntries, oldestSourcesById),
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async (entryIds) => { oldestProjectedSources = [...entryIds]; },
  });
  const oldestFirstPayload = oldestFirstAuthorization.kind === "allow"
    ? JSON.stringify(convertToLlm(oldestFirstAuthorization.enhancedContext))
    : "";
  checks.currentTurnOldestBatchProjectedFirst = oldestFirstAuthorization.kind === "allow"
    && oldestFirstAuthorization.metrics.rawToolBatches === 1
    && oldestFirstAuthorization.metrics.projectedToolBatches === 1
    && JSON.stringify(oldestProjectedSources) === JSON.stringify(["oldest-1", "oldest-2"])
    && oldestFirstPayload.includes("N".repeat(1_000))
    && !oldestFirstPayload.includes("O".repeat(1_000));

  const duplicateMessages = [
    { role: "user", content: "reject duplicate tool identifiers" },
    { role: "assistant", content: [{ type: "toolCall", id: "duplicate-call", name: "first", arguments: {} }] },
    { role: "toolResult", toolCallId: "duplicate-call", toolName: "first", content: [{ type: "text", text: "first" }], isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "duplicate-call", name: "second", arguments: {} }] },
    { role: "toolResult", toolCallId: "duplicate-call", toolName: "second", content: [{ type: "text", text: "second" }], isError: false },
  ];
  const duplicateEntries = duplicateMessages.map((message, index) => ({
    type: "message",
    id: `duplicate-${index}`,
    parentId: index === 0 ? null : `duplicate-${index - 1}`,
    timestamp: `2026-08-14T10:02:0${index}.000Z`,
    message,
  }));
  const duplicateSourcesById = new Map(projectRoute(profile, duplicateEntries, duplicateEntries.at(-1).id).projections
    .filter((projection) => projection.kind === "message-source")
    .map((projection) => [projection.id, projection]));
  const duplicateAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: duplicateMessages,
    providerPayloadProfile,
    toolSources: currentTurnToolSources(duplicateEntries, duplicateSourcesById),
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => undefined,
  });
  checks.currentTurnDuplicateIdsBlocked = duplicateAuthorization.kind === "block"
    && duplicateAuthorization.fault.kind === "tool-protocol";

  const modifiedSourceAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: currentMessages.map((message, index) => index === 2
      ? { ...message, content: [{ type: "text", text: `modified:${"M".repeat(200_000)}` }] }
      : message),
    providerPayloadProfile,
    toolSources: currentToolSources,
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => undefined,
  });
  checks.currentTurnModifiedSourceBlocks = modifiedSourceAuthorization.kind === "block"
    && modifiedSourceAuthorization.fault.kind === "source-barrier";

  const failedBarrierAuthorization = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: currentMessages,
    providerPayloadProfile,
    toolSources: currentToolSources,
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => { throw new Error("Projected source barrier failed"); },
  });
  checks.currentTurnSourceBarrierBlocks = failedBarrierAuthorization.kind === "block"
    && failedBarrierAuthorization.fault.kind === "source-barrier";

  const opaqueAuthorizationWithinBudget = await optimizer.authorize({
    generation,
    requestRoute: branchBHistorical.route,
    historical: branchBHistorical,
    messages: [
      { role: "user", content: "opaque current prompt" },
      { role: "assistant", content: [{ type: "toolCall", id: "large-call", name: "large_tool", arguments: {} }] },
      {
        role: "toolResult",
        toolCallId: "large-call",
        toolName: "large_tool",
        content: [{ type: "image", mimeType: "image/png", data: "I".repeat(30_000) }],
        isError: false,
      },
    ],
    providerPayloadProfile,
    toolSources: currentToolSources,
    toProviderMessages: (messages) => convertToLlm(messages),
    ensureSources: async () => undefined,
  });
  checks.currentTurnOpaqueOverflowBlocks = opaqueAuthorizationWithinBudget.kind === "block"
    && opaqueAuthorizationWithinBudget.fault.kind === "opaque-content-unrepresentable";
  let unsupportedPayloadApiRejected = false;
  try {
    createProviderPayloadProfile({ ...payloadProfileInput, api: "changed-api" });
  } catch {
    unsupportedPayloadApiRejected = true;
  }
  checks.providerPayloadProfileIdentity = unsupportedPayloadApiRejected
    && createProviderPayloadProfile(payloadProfileInput).identity === providerPayloadProfile.identity
    && [
    { ...payloadProfileInput, model: "changed" },
    { ...payloadProfileInput, baseUrl: "http://127.0.0.1/changed" },
    { ...payloadProfileInput, compat: { maxTokensField: "max_tokens" } },
    { ...payloadProfileInput, systemPrompt: "changed system" },
    { ...payloadProfileInput, tools: [...payloadProfileInput.tools, { name: "changed", description: "changed", parameters: {} }] },
    ].every((changed) => createProviderPayloadProfile(changed).identity !== providerPayloadProfile.identity);
  const wireProfileProof = {
    systemPromptHash: providerPayloadProfile.systemPromptHash,
    toolsHash: providerPayloadProfile.toolsHash,
    maxOutputTokens: providerPayloadProfile.maxOutputTokens,
  };
  const wireProfilePayload = {
    messages: [{ role: "system", content: payloadProfileInput.systemPrompt }],
    tools: payloadProfileInput.tools.map((tool) => ({
      type: "function",
      function: { ...tool, strict: false },
    })),
    max_completion_tokens: payloadProfileInput.maxOutputTokens,
  };
  checks.providerPayloadWireProfileBound = openAICompletionsToolPayloadUpperBoundBytes(payloadProfileInput.tools)
    === Buffer.byteLength(JSON.stringify(wireProfilePayload.tools), "utf8")
    && openAICompletionsPayloadMatchesProfile(wireProfilePayload, wireProfileProof)
    && openAICompletionsPayloadMatchesProfile({
      ...wireProfilePayload,
      messages: [{ role: "developer", content: payloadProfileInput.systemPrompt }],
    }, wireProfileProof)
    && !openAICompletionsPayloadMatchesProfile({
      ...wireProfilePayload,
      messages: [
        { role: "system", content: payloadProfileInput.systemPrompt },
        { role: "developer", content: payloadProfileInput.systemPrompt },
      ],
    }, wireProfileProof)
    && !openAICompletionsPayloadMatchesProfile({
      ...wireProfilePayload,
      messages: [{ role: "system", content: `${payloadProfileInput.systemPrompt} changed` }],
    }, wireProfileProof)
    && !openAICompletionsPayloadMatchesProfile({
      ...wireProfilePayload,
      tools: [...wireProfilePayload.tools, { type: "function", function: { name: "changed", description: "changed", parameters: {}, strict: false } }],
    }, wireProfileProof)
    && !openAICompletionsPayloadMatchesProfile({
      ...wireProfilePayload,
      max_completion_tokens: payloadProfileInput.maxOutputTokens + 1,
    }, wireProfileProof);
  const enhancedContent = adopted[0].content;
  const enhancedContentHash = createHash("sha256").update(JSON.stringify(enhancedContent)).digest("hex");
  checks.proofContentMutationRejected = payloadCarriesEnhancedContent(
    { messages: [{ content: [{ type: "text", text: enhancedContent }] }] },
    "validation-nonce",
    enhancedContentHash,
  ) && !payloadCarriesEnhancedContent(
    { messages: [{ content: [{ type: "text", text: `${enhancedContent}\nmutated` }] }] },
    "validation-nonce",
    enhancedContentHash,
  );
  const toolSequenceProof = createOpenAICompletionsPayloadProof(
    "context-enhancement-validation",
    "local",
    convertToLlm(adopted),
  );
  const toolSequencePayload = {
    model: "local",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: adopted[0].content }] },
      { role: "user", content: "current prompt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "current-tool",
          type: "function",
          function: { name: "read", arguments: "{}" },
        }],
      },
      { role: "tool", content: "current evidence", tool_call_id: "current-tool" },
    ],
  };
  checks.proofToolSequenceBound = Boolean(toolSequenceProof)
    && openAICompletionsPayloadMatches(toolSequencePayload, "validation-nonce", toolSequenceProof)
    && openAICompletionsPayloadMatches({
      ...toolSequencePayload,
      messages: [
        { role: "developer", content: "system" },
        ...toolSequencePayload.messages.slice(1),
      ],
    }, "validation-nonce", toolSequenceProof);

  const sequenceNonce = "validation-sequence-nonce";
  const sequenceAdopted = buildEnhancedContext([
    { role: "user", content: "sequence current prompt", timestamp: 10 },
    { role: "assistant", content: [{ type: "text", text: "sequence answer" }], timestamp: 11 },
  ], preparedB, sequenceNonce);
  const sequenceProof = createOpenAICompletionsPayloadProof(
    "context-enhancement-validation",
    "local",
    convertToLlm(sequenceAdopted),
  );
  const sequencePayloadMessages = [
    { role: "system", content: "system" },
    { role: "user", content: [{ type: "text", text: sequenceAdopted[0].content }] },
    { role: "user", content: "sequence current prompt" },
    { role: "assistant", content: "sequence answer" },
  ];
  checks.proofMessageSequenceBound = Boolean(sequenceProof)
    && openAICompletionsPayloadMatches({ model: "local", messages: sequencePayloadMessages }, sequenceNonce, sequenceProof)
    && !openAICompletionsPayloadMatches(
      {
        model: "local",
        messages: [
          sequencePayloadMessages[0],
          { role: "user", content: "injected prefix" },
          ...sequencePayloadMessages.slice(1),
        ],
      },
      sequenceNonce,
      sequenceProof,
    )
    && !openAICompletionsPayloadMatches(
      { model: "local", messages: [sequencePayloadMessages[0], sequencePayloadMessages[1], sequencePayloadMessages[3]] },
      sequenceNonce,
      sequenceProof,
    )
    && !openAICompletionsPayloadMatches(
      { model: "local", messages: [sequencePayloadMessages[0], sequencePayloadMessages[1], sequencePayloadMessages[3], sequencePayloadMessages[2]] },
      sequenceNonce,
      sequenceProof,
    )
    && !openAICompletionsPayloadMatches(
      { model: "changed", messages: sequencePayloadMessages },
      sequenceNonce,
      sequenceProof,
    )
    && !openAICompletionsPayloadMatches(
      {
        model: "local",
        messages: [
          ...sequencePayloadMessages.slice(0, -1),
          { ...sequencePayloadMessages.at(-1), name: "mutated" },
        ],
      },
      sequenceNonce,
      sequenceProof,
    );

  const createSessionMemory = (name, options = {}) => new OpenVikingSessionMemory(
    openViking.baseUrl,
    undefined,
    2_000,
    {
      generation: `validation-${name}`,
      capabilityProofId: `proof-${name}`,
      contextTokenBudget: 2_000,
      commitPendingTokens: 1,
      keepRecentMessages: 3,
      maxMirrors: 6,
      taskTimeoutMs: 2_000,
      taskPollMs: 5,
      ...options,
    },
  );
  const createRuntimeCoordinator = (name, memory) => new SessionMemoryCoordinator(
    identity,
    new FileLongTermMemory(join(artifactRoot, `archive-${name}`)),
    profile,
    memory,
  );

  openViking.state.skipNextCommit = true;
  const skippedCommitRequestStart = openViking.state.requests.length;
  const skippedCommitTaskCount = openViking.state.tasks.size;
  const skippedMemory = createSessionMemory("skipped", { keepRecentMessages: 100 });
  const skippedCoordinator = createRuntimeCoordinator("skipped", skippedMemory);
  const skippedRetention = createRetentionBudgetIdentity(providerProfile, skippedCoordinator.checkpointRetentionPolicy());
  const skippedRefresh = await skippedCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    skippedRetention,
    { required: false },
  );
  const skippedHistorical = await skippedCoordinator.resolveHistoricalContext(snapshot(identity, common), skippedRetention);
  const skippedPrepared = optimizer.prepare(skippedHistorical);
  const skippedCommitRequests = openViking.state.requests.slice(skippedCommitRequestStart);
  checks.skippedCommitRetainsActiveHistory = skippedRefresh.kind === "skipped"
    && skippedHistorical.checkpoint.coveredRouteEntryIds.length === 0
    && skippedHistorical.delta.sourceIds.length > 0
    && skippedPrepared.hasWorkingMemory === false
    && skippedPrepared.content.includes(commonRoute.leafId)
    && openViking.state.tasks.size === skippedCommitTaskCount
    && skippedCommitRequests.every((request) => !request.path.startsWith("/api/v1/tasks/"));
  await skippedMemory.shutdown();

  openViking.state.taskPollsBeforeCompletion = 2;
  const slowMemory = createSessionMemory("slow");
  const slowCoordinator = createRuntimeCoordinator("slow", slowMemory);
  const slowRetention = createRetentionBudgetIdentity(providerProfile, slowCoordinator.checkpointRetentionPolicy());
  const slowCommon = await slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    slowRetention,
    { required: true },
  );
  openViking.state.taskPollsBeforeCompletion = 100;
  const slowLatestEntries = [...branchA, {
    type: "message",
    id: "slow-route-latest",
    parentId: branchA.at(-1).id,
    timestamp: "2026-08-14T09:04:00.000Z",
    message: { role: "user", content: "latest route while working memory is running" },
  }];
  const slowLatestRoute = coordinator.identifyCurrentRoute(snapshot(identity, slowLatestEntries));
  const taskCountBeforeSlowRefresh = openViking.state.tasks.size;
  const slowRouteARefresh = slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchA),
    slowRetention,
    { required: false },
  );
  await waitFor(
    () => openViking.state.tasks.size > taskCountBeforeSlowRefresh,
    "slow checkpoint task",
  );
  const slowRouteAShared = slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchA),
    slowRetention,
    { required: true },
  );
  const commonReadyStarted = Date.now();
  const activeRouteAHistory = await slowCoordinator.resolveHistoricalContext(snapshot(identity, branchA), slowRetention);
  const commonReadyElapsedMs = Date.now() - commonReadyStarted;
  const activeRouteA = optimizer.prepare(activeRouteAHistory);
  const slowLatestRefresh = slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, slowLatestEntries),
    slowRetention,
    { required: false },
  );
  const latestReadyStarted = Date.now();
  const activeLatestHistory = await slowCoordinator.resolveHistoricalContext(snapshot(identity, slowLatestEntries), slowRetention);
  const latestReadyElapsedMs = Date.now() - latestReadyStarted;
  const activeLatest = optimizer.prepare(activeLatestHistory);
  const slowSession = openViking.state.sessions.get(
    slowCommon.kind === "accepted" ? slowCommon.checkpoint.openVikingSessionId : undefined,
  );
  const tasksBeforePromotion = [...openViking.state.tasks.values()]
    .filter((task) => task.session === slowSession && task.status !== "completed");
  const activeHistoryAdopted = buildEnhancedContext(currentTurn, activeRouteA, "validation-nonce");
  checks.inFlightReadyWaitBounded = Math.max(commonReadyElapsedMs, latestReadyElapsedMs) < 250;
  checks.activeHistoryAvailableDuringWorkingMemory = activeRouteA.hasWorkingMemory
    && activeRouteAHistory.delta.sourceIds.length > 0
    && activeHistoryAdopted?.[0]?.role === "custom"
    && activeHistoryAdopted?.[1] === currentTurn[2];
  checks.routesPrepareDuringWorkingMemory = activeRouteA.route.fingerprint === routeA.fingerprint
    && activeLatest.route.fingerprint === slowLatestRoute.fingerprint
    && activeRouteAHistory.checkpoint.identity === activeLatestHistory.checkpoint.identity;
  checks.singleCommitFlightPerMirror = slowSession?.commits === 2
    && tasksBeforePromotion.length === 1;
  const [slowRouteAResult, slowRouteASharedResult, slowLatestResult] = await Promise.all([
    slowRouteARefresh,
    slowRouteAShared,
    slowLatestRefresh,
  ]);
  const slowLatestHistorical = await slowCoordinator.resolveHistoricalContext(
    snapshot(identity, slowLatestEntries),
    slowRetention,
  );
  checks.latestRoutePromotedAfterCommit = slowRouteAResult.kind === "accepted"
    && slowRouteASharedResult.kind === "accepted"
    && slowRouteAResult.checkpoint.identity === slowRouteASharedResult.checkpoint.identity
    && slowLatestResult.kind === "accepted"
    && slowLatestHistorical.checkpoint.identity === slowLatestResult.checkpoint.identity
    && optimizer.prepare(slowLatestHistorical).hasWorkingMemory;
  checks.pendingTokensPreservedAcrossCommit = slowSession?.commits === 3;
  const slowTasks = [...openViking.state.tasks.values()].filter((task) => task.session === slowSession);
  checks.slowWorkingMemoryCompletesWithinDeadline = slowTasks.length === 3
    && slowTasks.every((task) => task.status === "completed")
    && slowTasks.slice(1).every((task) => task.polls >= 100);

  const smallerProfile = createProviderPayloadProfile({ ...payloadProfileInput, contextWindowTokens: 8_000 });
  const smallerRetention = createRetentionBudgetIdentity(smallerProfile, slowCoordinator.checkpointRetentionPolicy());
  openViking.state.taskPollsBeforeCompletion = 2;
  const smallerRefresh = await slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchA),
    smallerRetention,
    { required: true },
  );
  const smallerHistorical = await slowCoordinator.resolveHistoricalContext(
    snapshot(identity, branchA),
    smallerRetention,
  );
  checks.refreshTargetBudgetIsolation = smallerRetention !== slowRetention
    && smallerRefresh.kind === "accepted"
    && smallerHistorical.checkpoint.retentionBudgetIdentity === smallerRetention
    && smallerHistorical.checkpoint.identity !== slowRouteAResult.checkpoint.identity;

  openViking.state.taskPollsBeforeCompletion = 100;
  const cancelEntries = [...slowLatestEntries, {
    type: "message",
    id: "cancel-wait-entry",
    parentId: slowLatestEntries.at(-1).id,
    timestamp: "2026-08-14T09:05:00.000Z",
    message: { role: "user", content: "cancel only one checkpoint waiter" },
  }];
  const cancelBackground = slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, cancelEntries),
    slowRetention,
    { required: false },
  );
  const cancelController = new AbortController();
  const cancelledWaiter = slowCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, cancelEntries),
    slowRetention,
    { required: true, signal: cancelController.signal },
  ).then(() => false, () => true);
  cancelController.abort(new Error("controlled waiter cancellation"));
  const cancelResult = await cancelBackground;
  checks.refreshWaitCancellationIsolated = await cancelledWaiter
    && cancelResult.kind === "accepted";
  await slowMemory.shutdown();

  openViking.state.taskPollsBeforeCompletion = Number.MAX_SAFE_INTEGER;
  const timeoutMemory = createSessionMemory("timeout", { taskTimeoutMs: 30 });
  const timeoutCoordinator = createRuntimeCoordinator("timeout", timeoutMemory);
  const timeoutRetention = createRetentionBudgetIdentity(providerProfile, timeoutCoordinator.checkpointRetentionPolicy());
  let timeoutFailed = false;
  try {
    await timeoutCoordinator.scheduleCheckpointRefresh(snapshot(identity, common), timeoutRetention, { required: true });
  } catch {
    timeoutFailed = true;
  }
  const timeoutHistorical = await timeoutCoordinator.resolveHistoricalContext(snapshot(identity, common), timeoutRetention);
  checks.workingMemoryTimeoutRetainsActiveHistory = timeoutFailed
    && timeoutHistorical.checkpoint.coveredRouteEntryIds.length === 0
    && timeoutHistorical.delta.sourceIds.length > 0
    && optimizer.prepare(timeoutHistorical).hasWorkingMemory === false;
  await timeoutMemory.shutdown();

  openViking.state.taskPollsBeforeCompletion = 100;
  const commitShutdownBaseline = new Set(openViking.state.sessions.keys());
  const commitShutdownMemory = createSessionMemory("commit-shutdown");
  const commitShutdownCoordinator = createRuntimeCoordinator("commit-shutdown", commitShutdownMemory);
  const commitShutdownRetention = createRetentionBudgetIdentity(providerProfile, commitShutdownCoordinator.checkpointRetentionPolicy());
  const commitShutdownRefresh = commitShutdownCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    commitShutdownRetention,
    { required: true },
  ).then(() => false, () => true);
  await waitFor(() => openViking.state.tasks.size > taskCountBeforeSlowRefresh, "in-flight commit before shutdown");
  await commitShutdownMemory.shutdown();
  checks.inFlightCommitShutdownCleaned = await commitShutdownRefresh
    && [...openViking.state.sessions.keys()].every((sessionId) => commitShutdownBaseline.has(sessionId));

  openViking.state.taskPollsBeforeCompletion = 2;
  const failedMirrorBaseline = new Set(openViking.state.allSessions.keys());
  const failedMemory = createSessionMemory("failed");
  const failedCoordinator = createRuntimeCoordinator("failed", failedMemory);
  const failedRetention = createRetentionBudgetIdentity(providerProfile, failedCoordinator.checkpointRetentionPolicy());
  openViking.state.failNextContext = true;
  let backendFailed = false;
  try {
    await failedCoordinator.scheduleCheckpointRefresh(snapshot(identity, branchB), failedRetention, { required: true });
  } catch {
    backendFailed = true;
  }
  const failedHistorical = await failedCoordinator.resolveHistoricalContext(snapshot(identity, branchB), failedRetention);
  const retryAfterBackendFailure = await failedCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchB),
    failedRetention,
    { required: true },
  );
  const failedMirrorId = [...openViking.state.allSessions.keys()].find((sessionId) =>
    !failedMirrorBaseline.has(sessionId) && sessionId !== retryAfterBackendFailure.checkpoint?.openVikingSessionId);
  if (failedMirrorId) {
    await waitFor(() => openViking.state.deletedSessions.includes(failedMirrorId), "failed refresh mirror cleanup");
  }
  checks.backendFailureBlocks = backendFailed
    && failedHistorical.checkpoint.coveredRouteEntryIds.length === 0
    && failedHistorical.delta.sourceIds.length > 0
    && retryAfterBackendFailure.kind === "accepted"
    && Boolean(failedMirrorId)
    && openViking.state.deletedSessions.includes(failedMirrorId);
  await failedMemory.shutdown();

  openViking.state.taskPollsBeforeCompletion = 2;
  openViking.state.createResponseDelayMs = 250;
  const queueMemory = createSessionMemory("queue");
  const queueCoordinator = createRuntimeCoordinator("queue", queueMemory);
  const queueRetention = createRetentionBudgetIdentity(providerProfile, queueCoordinator.checkpointRetentionPolicy());
  const runningRefresh = queueCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    queueRetention,
    { required: false },
  );
  const supersededRefresh = queueCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, branchA),
    queueRetention,
    { required: false },
  );
  const latestRefresh = queueCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, slowLatestEntries),
    queueRetention,
    { required: false },
  );
  const [runningResult, supersededResult, latestResult] = await Promise.all([
    runningRefresh,
    supersededRefresh,
    latestRefresh,
  ]);
  checks.pendingRoutesCollapsed = runningResult.kind === "accepted"
    && supersededResult.kind === "superseded"
    && latestResult.kind === "accepted";
  await queueMemory.shutdown();

  const baselineSessionIds = new Set(openViking.state.sessions.keys());
  const createRequestsBeforeShutdownProbe = openViking.state.createRequests;
  const shutdownMemory = createSessionMemory("shutdown");
  const shutdownCoordinator = createRuntimeCoordinator("shutdown", shutdownMemory);
  const shutdownRetention = createRetentionBudgetIdentity(providerProfile, shutdownCoordinator.checkpointRetentionPolicy());
  const interruptedRefresh = shutdownCoordinator.scheduleCheckpointRefresh(
    snapshot(identity, common),
    shutdownRetention,
    { required: true },
  ).then(() => false, () => true);
  await waitFor(() => openViking.state.createRequests > createRequestsBeforeShutdownProbe, "in-flight Session creation request");
  await shutdownMemory.shutdown();
  const interrupted = await interruptedRefresh;
  openViking.state.createResponseDelayMs = 0;
  checks.inFlightShutdownCleaned = interrupted
    && [...openViking.state.sessions.keys()].every((sessionId) => baselineSessionIds.has(sessionId))
    && openViking.state.sessions.size === baselineSessionIds.size;

  const commitProtocolFailClosed = [
    { status: "accepted", task_id: null },
    { status: "skipped", task_id: "unexpected" },
    { status: "skipped", task_id: null, reason: 7 },
    { status: "unknown", task_id: null },
  ].every((response) => {
    try {
      normalizeCommitResult(response);
      return false;
    } catch {
      return true;
    }
  });
  const oversizedEntry = {
    type: "message",
    id: "bounded-openviking-projection",
    parentId: common.at(-1)?.id ?? null,
    timestamp: "2026-08-14T11:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Z".repeat(1_000_000) }], timestamp: Date.parse("2026-08-14T11:00:00.000Z") },
  };
  const oversizedSnapshot = snapshot(identity, [...common, oversizedEntry]);
  const boundedRequestOffset = openViking.state.requests.length;
  const boundedRefresh = await runtimeCoordinator.scheduleCheckpointRefresh(
    oversizedSnapshot,
    retentionBudgetIdentity,
    { required: true },
  );
  const boundedRequests = openViking.state.requests.slice(boundedRequestOffset)
    .filter((request) => request.method === "POST" && request.path.endsWith("/messages/batch"));
  const boundedProjection = projectMemorySources(runtimeCoordinator.projectCurrentRoute(oversizedSnapshot).projections)
    .find((projection) => projection.source_message_ids.includes(oversizedEntry.id));
  checks.openVikingAppendBounded = boundedRefresh.kind === "accepted"
    && Boolean(boundedProjection)
    && Buffer.byteLength(boundedProjection.content, "utf8") <= MAX_OPENVIKING_PROJECTION_BYTES
    && boundedProjection.content.includes("[OpenViking projection bounded;")
    && boundedRequests.length > 0
    && boundedRequests.every((request) => request.bodyBytes <= MAX_OPENVIKING_APPEND_BODY_BYTES)
    && boundedRequests.some((request) => request.hasBoundedProjection === true);

  const protocol = new Set(openViking.state.requests.map((request) => `${request.method} ${request.path.replace(/pcm-[^/]+/g, "<session>").replace(/task-\d+/g, "<task>")}`));
  checks.openVikingProtocolCovered = [
    "POST /api/v1/sessions",
    "POST /api/v1/sessions/<session>/messages/batch",
    "POST /api/v1/sessions/<session>/commit",
    "GET /api/v1/tasks/<task>",
    "GET /api/v1/sessions/<session>/context",
    "DELETE /api/v1/sessions/<session>",
  ].every((entry) => protocol.has(entry)) && commitProtocolFailClosed;
  const piAdoption = await runPiAdoptionCase(openViking);
  const piCurrentTurn = await runPiCurrentTurnCase(openViking);
  const piFooter = await runPiFooterCase(openViking);
  const authorizationBlock = await runAuthorizationBlockCase();
  checks.hookVerifiedAtExtension = piAdoption.hookVerifiedAndTransportAdopted;
  checks.spoofedMarkerCannotAuthorize = piAdoption.spoofedMarkerCannotAuthorize;
  checks.contextBlockStopsExtension = authorizationBlock.contextBlockStopsExtension;
  checks.hookOutcomeAccounting = piAdoption.hookOutcomeAccounting;
  checks.transportObservedIndependently = piAdoption.transportObservedIndependently
    && authorizationBlock.transportObservedIndependently;
  checks.inFlightContextWaitAdopted = piAdoption.inFlightContextWaitAdopted;
  checks.runtimeRevocationAtHookBlocked = piAdoption.runtimeRevocationAtHookBlocked;
  checks.desiredConfigDoesNotDisableRuntime = piAdoption.desiredConfigDoesNotDisableRuntime;
  checks.footerAdapterLifecycle = Object.values(piFooter).every(Boolean);
  checks.providerPayloadCurrentTurn = piAdoption.currentTurnOnly;
  checks.piCurrentTurnRaw = piCurrentTurn.raw;
  checks.piCurrentTurnProjected = piCurrentTurn.projected;
  checks.piCurrentTurnProtocolComplete = piCurrentTurn.protocolComplete;
  checks.piCurrentTurnSourcesRecoverable = piCurrentTurn.sourcesRecoverable;
  checks.piCurrentTurnTransportAdopted = piCurrentTurn.transportAdopted;
  checks.piProviderPayloadProfileMutationBlocked = piCurrentTurn.profileMutationBlocked;
  checks.piModifiedCurrentTurnSourceBlocked = piCurrentTurn.sourceMutationBlocked;
  checks.localProviderOnly = piAdoption.providerRequests > 5 && openViking.state.providerRequests === 0;
  checks.treeLifecycle = piAdoption.lifecycle.treeRoundTrip
    && piAdoption.lifecycle.treeSummarySuppression
    && piAdoption.lifecycle.treeHostMismatchDiagnosed
    && piAdoption.lifecycle.treeHandlerOrderObserved
    && piAdoption.lifecycle.treeCancellationState
    && piAdoption.lifecycle.rootNavigation
    && piAdoption.lifecycle.treeProviderAdoption;
  checks.sessionReplacementLifecycle = piAdoption.lifecycle.replacements
    && piAdoption.lifecycle.replacementProviderAdoption
    && piAdoption.lifecycle.reload;
  checks.compactionLifecycle = piAdoption.lifecycle.compactionSuppression
    && piAdoption.lifecycle.overflowRetrySuppressed
    && piAdoption.lifecycle.compactionContinuationAdopted;
  checks.backgroundRefreshFailureRetainsAuthorization = piAdoption.lifecycle.backgroundRefreshFailureRetainsAuthorization;
  checks.archiveFailureLatchesUntilNewGeneration = piAdoption.lifecycle.archiveRecovery;
  checks.hookTransportStateConsistent = piAdoption.lifecycle.providerStateConsistent;
  checks.memoryStatusThreeStateLifecycle = piAdoption.lifecycle.memoryStatusLifecycle;

  await sessionMemory.shutdown();
  checks.ownedSessionsCleaned = openViking.state.sessions.size === 0 && openViking.state.deletedSessions.length > 0;
  const failedChecks = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
  if (failedChecks.length > 0) throw new Error(`Context enhancement checks failed: ${failedChecks.join(", ")}`);

  details.routes = {
    common: commonRoute.fingerprint,
    branchA: routeA.fingerprint,
    branchB: routeB.fingerprint,
    afterCompaction: compactedRoute.fingerprint,
  };
  details.openViking = {
    sessionsCreated: openViking.state.createdSessions,
    sessionsDeleted: openViking.state.deletedSessions.length,
    tasks: openViking.state.tasks.size,
    requests: openViking.state.requests.length,
  };
  details.context = {
    branchAChars: preparedA.content.length,
    branchBChars: preparedB.content.length,
    compactedChars: preparedCompacted.content.length,
    branchBEstimatedTokens: preparedB.estimatedTokens,
  };
  details.summaryContamination = summaryContamination;
  details.pi = {
    providerRequests: piAdoption.providerRequests,
    contextAllowed: piAdoption.observations.filter((event) => event.type === "context_allowed").length,
    contextBlocked: piAdoption.observations.filter((event) => event.type === "context_blocked").length,
    hookOutcomes: Object.fromEntries(["verified", "rejected", "no-constructed-output"].map((outcome) => [
      outcome,
      piAdoption.observations.filter((event) => event.type === "before_provider_request" && event.hookOutcome === outcome).length,
    ])),
    transport: piAdoption.transportPartitions,
    currentTurnBudget: piCurrentTurn,
    authorizationBlock,
    footer: piFooter,
    lifecycle: piAdoption.lifecycle,
  };

  assertImplementationEvidenceUnchanged(root, "context-enhancement", implementation);
  const evidence = {
    schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
    generatedBy: "scripts/validate-context-enhancement.mjs",
    scope: "local",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    piVersion,
    nodeVersion: process.versions.node,
    piProtocolProfile: suite.host.pi.protocolProfile,
    openViking: {
      kind: "controlled-protocol",
      compatibilityTarget: openVikingCompatibilityTarget,
    },
    fixture: {
      path: "validation/fixtures/context-enhancement-long-task.json",
      name: fixture.name,
    },
    implementation,
    passed: true,
    checks,
    details,
    limitations: [
      "The local runner uses protocol-compatible OpenViking and task-Provider doubles and makes no external Provider requests.",
      "It proves route identity, runtime-generation gating, Pi tree/session-replacement/compaction lifecycle, bounded authorization, hook outcome accounting, independent local transport observation, block semantics, and derived-Session cleanup.",
      "Real memory-model task quality has a dedicated paired runner; complete API-cost attribution remains outside this local scope.",
    ],
  };
  replaceJson(evidencePath, evidence);
  writeJson(join(artifactRoot, "result.json"), evidence);
  console.log(`current evidence: ${evidencePath}`);
  console.log(`raw evidence: ${artifactRoot}`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (openViking) await openViking.close();
}
