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
import { projectRoute } from "../.pi/extensions/pi-context-memory/pi-session-protocol.ts";
import {
  createOpenAICompletionsPayloadProof,
  openAICompletionsPayloadMatches,
} from "../.pi/extensions/pi-context-memory/provider-payload-proof.ts";
import {
  DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS,
  projectMemorySources,
} from "../.pi/extensions/pi-context-memory/session-working-memory.ts";
import {
  buildEnhancedContext,
  DEFAULT_IN_FLIGHT_READY_WAIT_MS,
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
      state.requests.push({ method: request.method, path: url.pathname });
      const body = await readBody(request);
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
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeJson(join(agentDir, "settings.json"), {
    compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
  });
  mkdirSync(runtimeDir, { recursive: true });
  const memorySetting = { provider: "openai", model: "local-memory", api_key: "local-validation" };
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
    activeProvider: memorySetting.provider,
    activeModel: memorySetting.model,
    activeSettingsFingerprint,
    activeConfigFingerprint,
    targetProvider: memorySetting.provider,
    targetModel: memorySetting.model,
    targetSettingsFingerprint: activeSettingsFingerprint,
    targetConfigFingerprint: activeConfigFingerprint,
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
    "export default function lifecycleControl(pi) {",
    "  let cancelNextTree = false;",
    "  let cancelNextCompact = false;",
    "  pi.on(\"session_before_compact\", () => {",
    "    if (!cancelNextCompact) return;",
    "    cancelNextCompact = false;",
    "    return { cancel: true };",
    "  });",
    "  pi.on(\"session_before_tree\", () => {",
    "    if (!cancelNextTree) return;",
    "    cancelNextTree = false;",
    "    return { cancel: true };",
    "  });",
    "  pi.registerCommand(\"validation-tree\", {",
    "    description: \"Navigate the validation session tree\",",
    "    handler: async (args, ctx) => {",
    "      const [targetId, mode] = args.trim().split(/\\s+/);", // generated extension receives /\s+/
    "      if (!targetId || ![\"plain\", \"summary\"].includes(mode)) throw new Error(\"Usage: /validation-tree <entry-id> <plain|summary>\");",
    "      await ctx.navigateTree(targetId, { summarize: mode === \"summary\" });",
    "    },",
    "  });",
    "  pi.registerCommand(\"validation-cancel-tree\", {",
    "    description: \"Cancel the next validation tree navigation\",",
    "    handler: async (args, ctx) => {",
    "      cancelNextTree = true;",
    "      await ctx.navigateTree(args.trim(), { summarize: false });",
    "    },",
    "  });",
    "  pi.registerCommand(\"validation-cancel-compact\", {",
    "    description: \"Cancel the next validation compaction\",",
    "    handler: async () => { cancelNextCompact = true; },",
    "  });",
    "  pi.registerCommand(\"validation-reload\", {",
    "    description: \"Reload the validation runtime\",",
    "    handler: async (_args, ctx) => { await ctx.reload(); },",
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
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: archiveRoot,
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
      () => readObservations(observationLog).some((event) => event.type === "working_context_ready"),
      "turn-end working context",
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
        event.type === "working_context_ready"
        && event.sessionId === expected.sessionId
        && event.sessionFile === expected.sessionFile
        && event.leafId === expected.leafId),
      `working context for ${expected.sessionId}/${expected.leafId}`,
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

    const waitForCompactionProjection = async (observationOffset) => {
      const state = (await client.send("get_state")).data;
      const entriesResponse = await client.send("get_entries");
      const ready = await waitForWorkingContextAfter(observationOffset, {
        ...state,
        leafId: entriesResponse.data.leafId,
      });
      const routeEntries = activeRouteEntries(entriesResponse.data.entries, entriesResponse.data.leafId);
      const expectedIds = projectMemorySources(
        projectRoute(profile, routeEntries, entriesResponse.data.leafId).projections,
      ).flatMap((message) => message.source_message_ids);
      const mirror = openViking.state.allSessions.get(ready.openVikingSessionId);
      const actualIds = mirror?.batches.flat().flatMap((message) => message.source_message_ids) ?? [];
      return JSON.stringify(actualIds) === JSON.stringify(expectedIds);
    };
    const stableRuntimeRun = await promptAndSettle("sixth desired configuration remains active prompt");
    await promptAndSettle("seventh lifecycle baseline prompt");
    const backendFailureOffset = readObservations(observationLog).length;
    openViking.state.failContextCount = 1;
    await promptAndSettle("backend failure preparation prompt");
    await waitFor(
      () => readObservations(observationLog).slice(backendFailureOffset).some((event) => event.type === "working_context_error"),
      "Pi backend failure observation",
      10_000,
    );
    openViking.state.contextResponseDelayMs = 0;
    const backendNativeRun = await promptAndSettle("backend failure native probe");
    openViking.state.contextResponseDelayMs = 0;
    const generationRechecksBeforeRepair = readObservations(observationLog)
      .filter((event) => event.type === "memory_model_generation_recheck").length;
    replaceRuntimeGeneration("backend-revalidated");
    await waitFor(
      () => readObservations(observationLog)
        .filter((event) => event.type === "memory_model_generation_recheck").length > generationRechecksBeforeRepair,
      "explicit backend repair generation observation",
      10_000,
    );
    const recoveryReadyState = await waitForCurrentWorkingContext(backendFailureOffset);
    const backendRecoveredRun = await promptAndSettle("backend recovery enhanced probe");
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
          .some((event) => event.type === "archive_error"),
        "archive failure observation",
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
    const summaryToB = await runTreeNavigation(branchBLeafId, "summary");
    const summaryBState = await waitForCurrentWorkingContext(summaryBOffset);
    const summaryBRun = await promptAndSettle("tree summarized route B adoption probe");
    const returnAOffset = readObservations(observationLog).length;
    const returnToA = await runTreeNavigation(originalLeafId, "plain");
    const returnAState = await waitForCurrentWorkingContext(returnAOffset);
    const returnARun = await promptAndSettle("tree route A return adoption probe");
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
    const compactCountBeforeCancellation = readObservations(observationLog).filter((event) => event.type === "session_compact").length;
    const compactStatusBeforeCancellation = client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText;
    await client.send("prompt", { message: "/validation-cancel-compact" });
    const compactCancelled = await client.send("compact").then(() => false, (error) => String(error?.message ?? error).includes("cancelled"));
    await sleep(50);
    const canceledCompactStatusStable = compactCancelled && enhancementStatuses.has(compactStatusBeforeCancellation)
      && client.events.filter((event) => event.type === "extension_ui_request" && event.method === "setStatus").at(-1)?.statusText === compactStatusBeforeCancellation
      && readObservations(observationLog).filter((event) => event.type === "session_compact").length === compactCountBeforeCancellation;

    const manualObservationOffset = readObservations(observationLog).length;
    const manualBefore = readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "manual").length;
    await client.send("compact");
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "manual").length > manualBefore,
      "manual compaction lifecycle",
    );
    const manualProjectionMatches = await waitForCompactionProjection(manualObservationOffset);
    const manualReadyState = await waitForCurrentWorkingContext(manualObservationOffset);
    const manualAdoptionRun = await promptAndSettle("manual compaction enhanced adoption probe");

    const thresholdObservationOffset = readObservations(observationLog).length;
    const thresholdBefore = readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "threshold").length;
    provider.state.promptTokens = 16_000;
    await promptAndSettle("threshold compaction prompt");
    provider.state.promptTokens = 32;
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "threshold").length > thresholdBefore,
      "threshold compaction lifecycle",
    );
    const thresholdProjectionMatches = await waitForCompactionProjection(thresholdObservationOffset);
    const thresholdReadyState = await waitForCurrentWorkingContext(thresholdObservationOffset);
    const thresholdAdoptionRun = await promptAndSettle("threshold compaction enhanced adoption probe");
    await promptAndSettle("overflow preparation one");
    await promptAndSettle("overflow preparation two");
    const overflowObservationOffset = readObservations(observationLog).length;
    const overflowBefore = readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "overflow").length;
    const overflowPayloadOffset = provider.state.payloads.length;
    provider.state.rejectEnhancedOverflow = true;
    await promptAndSettle("overflow recovery prompt");
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "session_compact" && event.reason === "overflow").length > overflowBefore,
      "overflow compaction lifecycle",
    );
    const overflowProjectionMatches = await waitForCompactionProjection(overflowObservationOffset);
    const overflowPayloads = provider.state.payloads.slice(overflowPayloadOffset);
    const overflowVerifiedRequests = readObservations(observationLog)
      .slice(overflowObservationOffset)
      .filter((event) => event.type === "before_provider_request" && event.hookOutcome === "verified");
    const overflowTransportHashes = new Set(overflowPayloads.map((payload) => createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")));
    const overflowRetryAuthorized = overflowVerifiedRequests.length >= 2
      && overflowVerifiedRequests.every((event) => overflowTransportHashes.has(event.payloadHash));
    provider.state.rejectEnhancedOverflow = false;
    const overflowReadyState = await waitForCurrentWorkingContext(overflowObservationOffset);
    const overflowAdoptionRun = await promptAndSettle("overflow compaction enhanced adoption probe");

    openViking.state.contextResponseDelayMs = 120;
    await promptAndSettle("in-flight route preparation prompt");
    const inFlightWaitRun = await promptAndSettle("in-flight route adoption prompt");
    openViking.state.contextResponseDelayMs = 0;
    const inFlightWaitStart = inFlightWaitRun.observations.find((event) => event.type === "before_agent_start");
    const inFlightWaitReady = inFlightWaitRun.observations.find((event) => event.type === "working_context_ready");
    const inFlightWaitProvider = inFlightWaitRun.observations.find((event) => event.type === "before_provider_request");
    const inFlightWaitElapsedMs = inFlightWaitStart && inFlightWaitProvider
      ? Date.parse(inFlightWaitProvider.at) - Date.parse(inFlightWaitStart.at)
      : Number.POSITIVE_INFINITY;

    const observations = readObservations(observationLog);
    const treeEvents = observations.filter((event) => event.type === "session_tree");
    const compactionEvents = observations.filter((event) => event.type === "session_compact");
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
    const workingContextErrors = observations.filter((event) => event.type === "working_context_error");
    const expectedBackendFailure = workingContextErrors
      .filter((event) => event.error === "OpenViking HTTP 503: controlled context failure").length === 1;
    const lifecycle = {
      treeRoundTrip: plainToBranchPoint.newLeafId === branchPointId
        && plainToA.newLeafId === originalLeafId
        && summaryToB.summaryEntryId
        && returnToA.newLeafId === originalLeafId,
      treeSummaryChoices: plainToA.summaryEntryId === undefined && Boolean(summaryToB.summaryEntryId),
      treeCancellationState: canceledTreeStatusStable,
      rootNavigation: rootNavigation.newLeafId === userEntries[0].parentId
        && rootRun.observations.some((event) => event.type === "context_blocked")
        && rootRun.payloads.length === 0,
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
      compactionReasons: ["manual", "threshold", "overflow"].every((reason) => compactionEvents.some((event) => event.reason === reason))
        && compactionEvents.some((event) => event.reason === "overflow" && event.willRetry === true)
        && manualProjectionMatches
        && thresholdProjectionMatches
        && overflowProjectionMatches,
      overflowRetryAuthorized,
      compactionCancellationState: canceledCompactStatusStable,
      compactionProviderAdoption: requestAdoptedFor(manualAdoptionRun, manualReadyState)
        && requestAdoptedFor(thresholdAdoptionRun, thresholdReadyState)
        && requestAdoptedFor(overflowAdoptionRun, overflowReadyState),
      backendRecovery: backendNativeRun.observations.some((event) => event.type === "context_blocked")
        && backendNativeRun.payloads.length === 0
        && observations.slice(backendFailureOffset).some((event) =>
          event.type === "generation_fault_latched" && event.stage === "working-context")
        && observations.slice(backendFailureOffset).some((event) => event.type === "generation_fault_replaced")
        && requestAdoptedFor(backendRecoveredRun, recoveryReadyState)
        && expectedBackendFailure,
      archiveRecovery: archiveBlockedRun.observations.some((event) => event.type === "context_blocked")
        && archiveBlockedRun.payloads.length === 0
        && observations.slice(archiveFailureOffset).some((event) =>
          event.type === "generation_fault_latched" && event.stage === "archive")
        && observations.slice(archiveFailureOffset).some((event) => event.type === "generation_fault_replaced")
        && requestAdoptedFor(archiveRecoveredRun, archiveRecoveryReadyState),
      providerStateConsistent: uiProviderStateConsistent && hookOutcomeAccounting && transportObservedIndependently,
      memoryStatusLifecycle,
      eventCounts: {
        tree: treeEvents.length,
        compaction: compactionEvents.length,
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
      spoofedMarkerCannotAuthorize: spoofedMarkerObservations.some((event) => event.type === "context_blocked")
        && !spoofedMarkerObservations.some((event) => event.type === "context_allowed" || event.type === "before_provider_request")
        && spoofedMarkerTransportCount === 0,
      inFlightContextWaitAdopted: inFlightWaitProvider?.hookOutcome === "verified"
        && inFlightWaitProvider?.contextAuthorization === "allowed"
        && inFlightReadyIndex >= 0
        && inFlightProviderIndex > inFlightReadyIndex
        && inFlightWaitElapsedMs <= DEFAULT_IN_FLIGHT_READY_WAIT_MS + 50
        && runHasVerifiedTransport(inFlightWaitRun),
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
  const opaqueOptimizer = new WorkingContextOptimizer("http://127.0.0.1:1");
  const opaqueAuthorization = await opaqueOptimizer.authorize({
    generation: "validation-generation",
    route: commonRoute,
    projections: [{
      kind: "opaque-provider-segment",
      reason: "unsupported-content",
      entryIds: [commonRoute.entryIds[0]],
      providerMessages: [{ role: "user", content: [{ type: "image", data: "opaque" }] }],
      providerViewHash: "opaque",
    }],
    messages: [{ role: "user", content: "current prompt" }],
  });
  await opaqueOptimizer.shutdown();
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

  openViking = await startOpenVikingDouble();
  const optimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    maxMirrors: 6,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });

  const commonPrepared = await optimizer.prepare(commonRoute, commonProjections);
  const routeAPromise = optimizer.prepare(routeA, branchAProjections);
  checks.lateRouteResultRejected = optimizer.getReady(routeB) === undefined;
  const preparedA = await routeAPromise;
  checks.lateRouteResultRejected &&= optimizer.getReady(routeB) === undefined;
  const preparedB = await optimizer.prepare(routeB, branchBProjections);
  const preparedOther = await optimizer.prepare(otherRoute, branchBProjections);
  const preparedReplacement = await optimizer.prepare(replacementRoute, branchBProjections);
  checks.sessionIsolation &&= preparedOther.openVikingSessionId !== preparedB.openVikingSessionId
    && preparedReplacement.openVikingSessionId !== preparedB.openVikingSessionId
    && preparedReplacement.openVikingSessionId !== preparedOther.openVikingSessionId;
  const preparedCompacted = await optimizer.prepare(compactedRoute, compactedProjections);

  checks.linearRouteReused = commonPrepared.openVikingSessionId === preparedA.openVikingSessionId;
  checks.branchIsolation = preparedA.openVikingSessionId !== preparedB.openVikingSessionId
    && !openViking.state.sessions.get(preparedB.openVikingSessionId).messages
      .some((message) => message.source_message_ids?.includes("a0000009"));
  checks.workingMemoryAssembled = preparedB.hasWorkingMemory
    && preparedB.content.includes("Working memory")
    && preparedB.content.includes("b000000c");
  const boundaryContext = formatWorkingContext(routeB, {
    overview: "O".repeat(5_000),
    messages: [{ role: "user", text: "A".repeat(5_000), sourceMessageIds: ["boundary"] }],
    estimatedTokens: 2_500,
  }, 1_600);
  checks.contextBounded = preparedB.content.length <= 1_600
    && preparedCompacted.content.length <= 1_600
    && boundaryContext.length <= 1_600
    && boundaryContext.includes("## Working memory")
    && boundaryContext.includes("## Active history");

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
    && openAICompletionsPayloadMatches(toolSequencePayload, "validation-nonce", toolSequenceProof);

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

  openViking.state.skipNextCommit = true;
  const skippedCommitRequestStart = openViking.state.requests.length;
  const skippedCommitTaskCount = openViking.state.tasks.size;
  const skippedCommitOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 100,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  let skippedCommitPrepared;
  let skippedCommitError;
  try {
    skippedCommitPrepared = await skippedCommitOptimizer.prepare(commonRoute, commonProjections);
  } catch (error) {
    skippedCommitError = error;
  }
  const skippedCommitRequests = openViking.state.requests.slice(skippedCommitRequestStart);
  checks.skippedCommitRetainsActiveHistory = skippedCommitError === undefined
    && skippedCommitPrepared?.hasWorkingMemory === false
    && skippedCommitPrepared.content.includes(commonRoute.leafId)
    && openViking.state.tasks.size === skippedCommitTaskCount
    && skippedCommitRequests.every((request) => !request.path.startsWith("/api/v1/tasks/"));
  await skippedCommitOptimizer.shutdown();

  openViking.state.taskPollsBeforeCompletion = 100;
  const slowTaskOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 1_000,
    taskPollMs: 5,
  });
  const slowLatestEntries = [...branchA, {
    type: "message",
    id: "slow-route-latest",
    parentId: branchA.at(-1).id,
    timestamp: "2026-08-14T09:04:00.000Z",
    message: { role: "user", content: "latest route while working memory is running" },
  }];
  const slowLatestRoute = coordinator.identifyCurrentRoute(snapshot(identity, slowLatestEntries));
  const slowLatestProjections = projectRoute(
    profile,
    slowLatestEntries,
    slowLatestEntries.at(-1)?.id ?? null,
  ).projections;
  const slowTaskPreparation = slowTaskOptimizer.prepare(commonRoute, commonProjections);
  const commonReadyStarted = Date.now();
  const activeWhileCommitting = await slowTaskOptimizer.waitForReady(commonRoute, DEFAULT_IN_FLIGHT_READY_WAIT_MS);
  const commonReadyElapsedMs = Date.now() - commonReadyStarted;
  const activeWhileCommittingTask = [...openViking.state.tasks.values()].at(-1);
  const slowRouteAPreparation = slowTaskOptimizer.prepare(routeA, branchAProjections);
  const routeAReadyStarted = Date.now();
  const activeRouteA = await slowTaskOptimizer.waitForReady(routeA, DEFAULT_IN_FLIGHT_READY_WAIT_MS);
  const routeAReadyElapsedMs = Date.now() - routeAReadyStarted;
  const slowLatestPreparation = slowTaskOptimizer.prepare(slowLatestRoute, slowLatestProjections);
  const latestReadyStarted = Date.now();
  const activeLatest = await slowTaskOptimizer.waitForReady(slowLatestRoute, DEFAULT_IN_FLIGHT_READY_WAIT_MS);
  const latestReadyElapsedMs = Date.now() - latestReadyStarted;
  const slowSession = openViking.state.sessions.get(activeWhileCommitting?.openVikingSessionId);
  const tasksBeforePromotion = [...openViking.state.tasks.values()]
    .filter((task) => task.session === slowSession);
  const activeHistoryAdopted = activeWhileCommitting
    ? buildEnhancedContext(currentTurn, activeWhileCommitting, "validation-nonce")
    : [];
  checks.inFlightReadyWaitBounded = DEFAULT_IN_FLIGHT_READY_WAIT_MS === 1_000
    && Math.max(commonReadyElapsedMs, routeAReadyElapsedMs, latestReadyElapsedMs) <= DEFAULT_IN_FLIGHT_READY_WAIT_MS + 50;
  checks.activeHistoryAvailableDuringWorkingMemory = activeWhileCommitting?.hasWorkingMemory === false
    && activeWhileCommittingTask?.polls < 100
    && activeHistoryAdopted[0]?.role === "custom"
    && activeHistoryAdopted[1] === currentTurn[2];
  checks.routesPrepareDuringWorkingMemory = activeRouteA?.route.fingerprint === routeA.fingerprint
    && activeLatest?.route.fingerprint === slowLatestRoute.fingerprint
    && activeLatest.hasWorkingMemory === false
    && activeWhileCommitting?.openVikingSessionId === activeRouteA.openVikingSessionId
    && activeRouteA.openVikingSessionId === activeLatest.openVikingSessionId;
  checks.singleCommitFlightPerMirror = slowSession?.commits === 1
    && tasksBeforePromotion.length === 1
    && tasksBeforePromotion[0]?.status !== "completed";
  const [slowCommonPrepared, slowRouteAPrepared, slowLatestPrepared] = await Promise.all([
    slowTaskPreparation,
    slowRouteAPreparation,
    slowLatestPreparation,
  ]);
  checks.latestRoutePromotedAfterCommit = slowCommonPrepared.hasWorkingMemory === false
    && slowRouteAPrepared.hasWorkingMemory === false
    && slowLatestPrepared.hasWorkingMemory
    && slowTaskOptimizer.getReady(slowLatestRoute)?.hasWorkingMemory === true
    && slowTaskOptimizer.getReady(routeA)?.hasWorkingMemory === false
    && slowLatestPrepared.content.includes(slowLatestRoute.leafId);
  checks.pendingTokensPreservedAcrossCommit = slowSession?.commits === 2;
  checks.slowWorkingMemoryCompletesWithinDeadline = activeWhileCommittingTask?.status === "completed"
    && activeWhileCommittingTask.polls >= 100;
  await slowTaskOptimizer.shutdown();

  openViking.state.taskPollsBeforeCompletion = Number.MAX_SAFE_INTEGER;
  const timeoutOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 30,
    taskPollMs: 5,
  });
  const timeoutPrepared = await timeoutOptimizer.prepare(commonRoute, commonProjections);
  checks.workingMemoryTimeoutRetainsActiveHistory = timeoutPrepared.hasWorkingMemory === false
    && timeoutOptimizer.getReady(commonRoute)?.content === timeoutPrepared.content;
  await timeoutOptimizer.shutdown();

  const commitShutdownBaseline = new Set(openViking.state.sessions.keys());
  const commitShutdownOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  const commitShutdownPreparation = commitShutdownOptimizer.prepare(commonRoute, commonProjections).then(
    () => false,
    () => true,
  );
  const commitShutdownActive = await commitShutdownOptimizer.waitForReady(commonRoute, DEFAULT_IN_FLIGHT_READY_WAIT_MS);
  await commitShutdownOptimizer.shutdown();
  checks.inFlightCommitShutdownCleaned = commitShutdownActive?.hasWorkingMemory === false
    && await commitShutdownPreparation
    && [...openViking.state.sessions.keys()].every((sessionId) => commitShutdownBaseline.has(sessionId))
    && openViking.state.sessions.size === commitShutdownBaseline.size;
  openViking.state.taskPollsBeforeCompletion = 2;

  const failedOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  openViking.state.failNextContext = true;
  let backendFailed = false;
  try {
    await failedOptimizer.prepare(routeB, branchBProjections);
  } catch {
    backendFailed = true;
  }
  checks.backendFailureBlocks = backendFailed && failedOptimizer.getReady(routeB) === undefined;
  await failedOptimizer.shutdown();
  const queueOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  const runningPreparation = queueOptimizer.prepare(commonRoute, commonProjections);
  const supersededPreparation = queueOptimizer.prepare(routeA, branchAProjections).then(
    () => false,
    (error) => String(error).includes("superseded"),
  );
  const latestPreparation = queueOptimizer.prepare(routeB, branchBProjections);
  const [runningPrepared, superseded, latestPrepared] = await Promise.all([
    runningPreparation,
    supersededPreparation,
    latestPreparation,
  ]);
  checks.pendingRoutesCollapsed = runningPrepared.route.fingerprint === commonRoute.fingerprint
    && superseded
    && latestPrepared.route.fingerprint === routeB.fingerprint;
  await queueOptimizer.shutdown();
  const baselineSessionIds = new Set(openViking.state.sessions.keys());
  const createRequestsBeforeShutdownProbe = openViking.state.createRequests;
  openViking.state.createResponseDelayMs = 250;
  const shutdownOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  const interruptedPreparation = shutdownOptimizer.prepare(commonRoute, commonProjections).then(
    () => false,
    () => true,
  );
  await waitFor(() => openViking.state.createRequests > createRequestsBeforeShutdownProbe, "in-flight Session creation request");
  await shutdownOptimizer.shutdown();
  const interrupted = await interruptedPreparation;
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
  const authorizationBlock = await runAuthorizationBlockCase();
  checks.hookVerifiedAtExtension = piAdoption.hookVerifiedAndTransportAdopted;
  checks.spoofedMarkerCannotAuthorize = piAdoption.spoofedMarkerCannotAuthorize;
  checks.contextBlockStopsExtension = authorizationBlock.contextBlockStopsExtension;
  checks.hookOutcomeAccounting = piAdoption.hookOutcomeAccounting;
  checks.transportObservedIndependently = piAdoption.transportObservedIndependently
    && authorizationBlock.transportObservedIndependently;
  checks.inFlightContextWaitAdopted = piAdoption.inFlightContextWaitAdopted;
  checks.desiredConfigDoesNotDisableRuntime = piAdoption.desiredConfigDoesNotDisableRuntime;
  checks.providerPayloadCurrentTurn = piAdoption.currentTurnOnly;
  checks.localProviderOnly = piAdoption.providerRequests > 5 && openViking.state.providerRequests === 0;
  checks.treeLifecycle = piAdoption.lifecycle.treeRoundTrip
    && piAdoption.lifecycle.treeSummaryChoices
    && piAdoption.lifecycle.treeCancellationState
    && piAdoption.lifecycle.rootNavigation
    && piAdoption.lifecycle.treeProviderAdoption;
  checks.sessionReplacementLifecycle = piAdoption.lifecycle.replacements
    && piAdoption.lifecycle.replacementProviderAdoption
    && piAdoption.lifecycle.reload;
  checks.compactionLifecycle = piAdoption.lifecycle.compactionReasons
    && piAdoption.lifecycle.overflowRetryAuthorized
    && piAdoption.lifecycle.compactionCancellationState
    && piAdoption.lifecycle.compactionProviderAdoption;
  checks.backendFailureLatchesUntilNewGeneration = piAdoption.lifecycle.backendRecovery;
  checks.archiveFailureLatchesUntilNewGeneration = piAdoption.lifecycle.archiveRecovery;
  checks.hookTransportStateConsistent = piAdoption.lifecycle.providerStateConsistent;
  checks.memoryStatusThreeStateLifecycle = piAdoption.lifecycle.memoryStatusLifecycle;

  await optimizer.shutdown();
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
  details.pi = {
    providerRequests: piAdoption.providerRequests,
    contextAllowed: piAdoption.observations.filter((event) => event.type === "context_allowed").length,
    contextBlocked: piAdoption.observations.filter((event) => event.type === "context_blocked").length,
    hookOutcomes: Object.fromEntries(["verified", "rejected", "no-constructed-output"].map((outcome) => [
      outcome,
      piAdoption.observations.filter((event) => event.type === "before_provider_request" && event.hookOutcome === outcome).length,
    ])),
    transport: piAdoption.transportPartitions,
    authorizationBlock,
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
