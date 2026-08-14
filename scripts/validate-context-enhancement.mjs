#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
} from "./validation-evidence.mjs";
import { FileLongTermMemory } from "../.pi/extensions/pi-context-memory/long-term-memory.ts";
import { compileOpenVikingConfig } from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import { SessionMemoryCoordinator } from "../.pi/extensions/pi-context-memory/session-memory-coordination.ts";
import { projectRouteEntries } from "../.pi/extensions/pi-context-memory/session-working-memory.ts";
import {
  applyPreparedWorkingContext,
  formatWorkingContext,
  WorkingContextOptimizer,
} from "../.pi/extensions/pi-context-memory/working-context-optimization.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-context-enhancement.mjs");
const runId = process.env.PCR_RUN_ID ?? `context-enhancement-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/context-enhancement", runId);
const fixturePath = join(root, "validation/fixtures/context-enhancement-long-task.json");
const evidencePath = join(root, "validation/evidence/context-enhancement.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
mkdirSync(artifactRoot, { recursive: true });
const implementation = captureImplementationEvidence(root, "context-enhancement");
const startedAt = new Date().toISOString();

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
    createdSessions: 0,
    createRequests: 0,
    tasks: new Map(),
    requests: [],
    deletedSessions: [],
    createResponseDelayMs: 0,
    failNextContext: false,
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
        state.sessions.set(id, { id, messages: [], pendingTokens: 0, overview: "", batches: [], commits: 0 });
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
        const taskId = `task-${state.tasks.size + 1}`;
        session.commits += 1;
        state.tasks.set(taskId, {
          id: taskId,
          status: "pending",
          polls: 0,
          session,
          keepRecent: Number.isSafeInteger(body?.keep_recent_count) ? body.keep_recent_count : 0,
        });
        send(response, 200, { status: "ok", result: { task_id: taskId, session_id: session.id } });
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
        if (task.polls >= 2 && task.status !== "completed") {
          task.status = "completed";
          task.session.overview = [
            "# Working Memory",
            ...task.session.messages.map((message) => textOfProjection(message)),
          ].join("\n\n");
          task.session.messages = task.keepRecent > 0 ? task.session.messages.slice(-task.keepRecent) : [];
          task.session.pendingTokens = task.session.messages.reduce(
            (total, message) => total + Math.max(1, Math.ceil(textOfProjection(message).length / 4)),
            0,
          );
        }
        send(response, 200, { status: "ok", result: { task_id: task.id, status: task.status } });
        return;
      }

      const contextMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/context$/);
      if (request.method === "GET" && contextMatch) {
        if (state.failNextContext) {
          state.failNextContext = false;
          send(response, 503, { status: "error", error: { message: "controlled context failure" } });
          return;
        }
        const session = state.sessions.get(decodeURIComponent(contextMatch[1]));
        if (!session) {
          send(response, 404, { status: "error", error: { message: "session not found" } });
          return;
        }
        const messages = session.messages.map(assembledMessage);
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
  const payloads = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      send(response, 404, { error: { message: "unknown provider endpoint" } });
      return;
    }
    payloads.push(body);
    const id = `chatcmpl-${payloads.length}`;
    const created = Math.floor(Date.now() / 1_000);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: `local response ${payloads.length}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 } })}\n\n`);
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
    payloads,
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
  const settingsPath = join(caseDir, "memory-model.jsonc");
  const providerPath = join(caseDir, "local-provider.ts");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const memorySetting = { provider: "openai", model: "local-memory" };
  const settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(memorySetting).sort(([left], [right]) => left.localeCompare(right)))))
    .digest("hex");
  const compiledMemoryConfig = await compileOpenVikingConfig(root, memorySetting, {
    ...process.env,
    HOME: home,
    PCR_OPENVIKING_VLM_API_KEY: "local-validation",
  });
  writeFileSync(settingsPath, `${JSON.stringify({ memoryModel: memorySetting })}\n`, "utf8");

  const launchId = `context-enhancement-${process.pid}`;
  writeJson(join(runtimeDir, "launcher.lock"), { launchId, launcherPid: process.pid });
  writeJson(join(runtimeDir, "launcher.json"), {
    schemaVersion: 1,
    launchId,
    launcherPid: process.pid,
    controlUrl: "http://127.0.0.1:1",
    operationTimeoutMs: 30_000,
  });
  const writeRuntimeState = (
    activeSettingsFingerprint,
    activeConfigFingerprint = compiledMemoryConfig.configFingerprint,
  ) => writeJson(join(runtimeDir, "state.json"), {
    schemaVersion: 1,
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
      PCR_OPENVIKING_VLM_API_KEY: "local-validation",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: join(caseDir, "archive"),
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
    await client.send("prompt", { message: "fourth current prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 4,
      "fourth Pi agent settlement",
    );
    writeRuntimeState(settingsFingerprint, "post-ready-wrong-config");
    await client.send("prompt", { message: "fifth post-ready mismatch prompt" });
    await waitFor(
      () => readObservations(observationLog).filter((event) => event.type === "agent_settled").length >= 5,
      "fifth Pi agent settlement",
    );
    const observations = readObservations(observationLog);
    const providerRequestObservations = observations.filter((event) => event.type === "before_provider_request");
    const firstProviderRequest = providerRequestObservations[0];
    const mismatchedRuntimeRequest = providerRequestObservations[1];
    const postReadyMismatchRequest = providerRequestObservations[4];
    const enhancedContext = observations.findLast((event) => event.type === "context" && event.contextPath === "enhanced");
    const enhancedProviderRequest = observations.findLast((event) => event.type === "before_provider_request" && event.contextPath === "enhanced");
    const finalPayload = provider.payloads[3];
    const providerMessages = Array.isArray(finalPayload?.messages) ? finalPayload.messages : [];
    const priorPromptMessages = providerMessages.filter((message) => [
      "first persisted prompt # Enhanced session context",
      "second mismatched-runtime prompt",
      "third route preparation prompt",
    ].includes(message.content));
    const payloadText = JSON.stringify(finalPayload);
    return {
      adopted: Boolean(enhancedContext?.preparedContextHash) && Boolean(enhancedProviderRequest)
        && payloadText.includes("# Enhanced session context")
        && payloadText.includes("fourth current prompt"),
      spoofedMarkerRemainsNative: firstProviderRequest?.contextPath === "pi-native"
        && firstProviderRequest?.payloadHasEnhancedContext === true
        && firstProviderRequest?.contextDecision === "pi-native",
      mismatchedRuntimeRemainsNative: firstProviderRequest?.contextPath === "pi-native"
        && firstProviderRequest?.contextDecision === "pi-native"
        && mismatchedRuntimeRequest?.contextPath === "pi-native"
        && mismatchedRuntimeRequest?.contextDecision === "pi-native"
        && postReadyMismatchRequest?.contextPath === "pi-native"
        && postReadyMismatchRequest?.contextDecision === "pi-native",
      currentTurnOnly: priorPromptMessages.length === 0,
      providerRequests: provider.payloads.length,
      observations,
      payloads: provider.payloads,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`);
  } finally {
    await client.close();
    await provider.close();
    writeJson(join(caseDir, "rpc-events.json"), client.events);
    writeJson(join(caseDir, "provider-payloads.json"), provider.payloads);
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

  const common = routeEntries("common");
  const branchA = routeEntries("branchA");
  const branchB = routeEntries("branchB");
  const afterCompaction = routeEntries("afterCompaction");
  const identity = {
    sessionId: "context-enhancement-session",
    sessionFile: join(artifactRoot, "session.jsonl"),
  };
  const coordinator = new SessionMemoryCoordinator(identity, new FileLongTermMemory(join(artifactRoot, "archive")));
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

  const otherIdentity = {
    sessionId: "other-context-enhancement-session",
    sessionFile: join(artifactRoot, "other-session.jsonl"),
  };
  const otherCoordinator = new SessionMemoryCoordinator(otherIdentity, new FileLongTermMemory(join(artifactRoot, "archive")));
  const otherRoute = otherCoordinator.identifyCurrentRoute(snapshot(otherIdentity, branchB));
  checks.sessionIsolation = otherRoute.fingerprint !== routeB.fingerprint;

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

  const commonPrepared = await optimizer.prepare(commonRoute, common);
  const routeAPromise = optimizer.prepare(routeA, branchA);
  checks.lateRouteResultRejected = optimizer.getReady(routeB) === undefined;
  const preparedA = await routeAPromise;
  checks.lateRouteResultRejected &&= optimizer.getReady(routeB) === undefined;
  const preparedB = await optimizer.prepare(routeB, branchB);
  const preparedCompacted = await optimizer.prepare(compactedRoute, afterCompaction);

  checks.linearRouteReused = commonPrepared.openVikingSessionId === preparedA.openVikingSessionId;
  checks.branchIsolation = preparedA.openVikingSessionId !== preparedB.openVikingSessionId
    && !openViking.state.sessions.get(preparedB.openVikingSessionId).messages
      .some((message) => message.source_message_ids?.includes("a0000009"));
  checks.workingMemoryAssembled = preparedB.hasWorkingMemory
    && preparedB.content.includes("Working memory")
    && preparedB.content.includes("b000000c");
  const boundaryContext = formatWorkingContext(routeB, {
    latestArchiveOverview: "O".repeat(5_000),
    messages: [{ role: "user", parts: [{ type: "text", text: "A".repeat(5_000) }], source_message_ids: ["boundary"] }],
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

  const compactedProjectionIds = projectRouteEntries(afterCompaction)
    .flatMap((message) => message.source_message_ids);
  const latestCompactionBatch = openViking.state.sessions
    .get(preparedCompacted.openVikingSessionId)
    .batches.at(-1)
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
  const retainedTailProjections = projectRouteEntries([...common, retainedTailCompaction, retainedTailAfter]);
  checks.compactionBoundary = JSON.stringify(compactedProjectionIds) === JSON.stringify([
    "c0000001", "b0000009", "b000000a", "b000000c", "b000000d", "c0000002",
  ])
    && JSON.stringify(latestCompactionBatch) === JSON.stringify(["c0000001", "c0000002"])
    && JSON.stringify(retainedTailProjections.flatMap((message) => message.source_message_ids))
      === JSON.stringify(["retained-tail-compaction", "retained-tail-after"])
    && retainedTailProjections[0].content.includes("retained-tail goal")
    && preparedCompacted.content.includes("b000000c");

  const currentTurn = [
    { role: "user", content: "old prompt", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
    { role: "user", content: "current prompt", timestamp: 3 },
    { role: "assistant", content: [{ type: "toolCall", id: "current-tool", name: "read", arguments: {} }], timestamp: 4 },
    { role: "toolResult", toolCallId: "current-tool", toolName: "read", content: [{ type: "text", text: "current evidence" }], isError: false, timestamp: 5 },
  ];
  const adopted = applyPreparedWorkingContext(currentTurn, preparedB);
  checks.currentTurnPreserved = adopted.length === 4
    && adopted[0].role === "custom"
    && adopted[0].customType === "pi-context-memory"
    && adopted[1] === currentTurn[2]
    && adopted[2] === currentTurn[3]
    && adopted[3] === currentTurn[4];

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
    await failedOptimizer.prepare(routeB, branchB);
  } catch {
    backendFailed = true;
  }
  checks.backendFailureFallsBack = backendFailed && failedOptimizer.getReady(routeB) === undefined;
  await failedOptimizer.shutdown();
  const queueOptimizer = new WorkingContextOptimizer(openViking.baseUrl, undefined, 2_000, {
    contextTokenBudget: 2_000,
    commitPendingTokens: 1,
    keepRecentMessages: 3,
    maxContextChars: 1_600,
    taskTimeoutMs: 2_000,
    taskPollMs: 5,
  });
  const runningPreparation = queueOptimizer.prepare(commonRoute, common);
  const supersededPreparation = queueOptimizer.prepare(routeA, branchA).then(
    () => false,
    (error) => String(error).includes("superseded"),
  );
  const latestPreparation = queueOptimizer.prepare(routeB, branchB);
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
  const interruptedPreparation = shutdownOptimizer.prepare(commonRoute, common).then(
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

  const protocol = new Set(openViking.state.requests.map((request) => `${request.method} ${request.path.replace(/pcm-[^/]+/g, "<session>").replace(/task-\d+/g, "<task>")}`));
  checks.openVikingProtocolCovered = [
    "POST /api/v1/sessions",
    "POST /api/v1/sessions/<session>/messages/batch",
    "POST /api/v1/sessions/<session>/commit",
    "GET /api/v1/tasks/<task>",
    "GET /api/v1/sessions/<session>/context",
    "DELETE /api/v1/sessions/<session>",
  ].every((entry) => protocol.has(entry));
  const piAdoption = await runPiAdoptionCase(openViking);
  checks.piContextHookAdopted = piAdoption.adopted;
  checks.providerStateUnspoofable = piAdoption.spoofedMarkerRemainsNative;
  checks.mismatchedRuntimeRejected = piAdoption.mismatchedRuntimeRemainsNative;
  checks.providerPayloadCurrentTurn = piAdoption.currentTurnOnly;
  checks.localProviderOnly = piAdoption.providerRequests === 5 && openViking.state.providerRequests === 0;

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
    enhancedContextEvents: piAdoption.observations.filter((event) => event.type === "context" && event.contextPath === "enhanced").length,
  };

  assertImplementationEvidenceUnchanged(root, "context-enhancement", implementation);
  const evidence = {
    schemaVersion: 1,
    generatedBy: "scripts/validate-context-enhancement.mjs",
    scope: "local",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    piVersion: "0.84.1",
    openVikingVersion: "0.4.13-protocol",
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
      "It proves route identity, runtime-generation gating, Working Memory/context assembly control flow, bounded adoption, compaction projection, failure fallback, and derived-Session cleanup.",
      "Real memory-model semantic quality, complete Pi tree/compaction lifecycle, UI persistence, and paired API cost remain in the next longitudinal delivery.",
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
