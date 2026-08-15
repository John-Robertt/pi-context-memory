#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import {
  assertValidationPiVersion,
  readProjectOpenVikingVersion,
} from "./validation-suite.mjs";

import { FileLongTermMemory } from "../.pi/extensions/pi-context-memory/long-term-memory.ts";
import {
  expandSource,
  OpenVikingSourceRecall,
} from "../.pi/extensions/pi-context-memory/recall-and-provenance.ts";
import {
  SessionMemoryCoordinator,
  SessionSourceIndexCoordinator,
} from "../.pi/extensions/pi-context-memory/session-memory-coordination.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-source-recall.mjs");
const scope = "local";
const implementation = captureImplementationEvidence(root, "source-recall");
const expectedOpenVikingVersion = readProjectOpenVikingVersion(root);
const piVersion = assertValidationPiVersion(root);

const openVikingConfigPath = join(root, "config/openviking.json");
const baseOpenVikingConfig = JSON.parse(readFileSync(openVikingConfigPath, "utf8"));
const openVikingConfig = {
  default_account: baseOpenVikingConfig.default_account,
  default_user: baseOpenVikingConfig.default_user,
  embedding: baseOpenVikingConfig.embedding,
};
if (typeof openVikingConfig.default_account !== "string" || typeof openVikingConfig.default_user !== "string") {
  throw new Error("Source recall validation base config requires account and user identities");
}
const denseEmbedding = openVikingConfig.embedding?.dense;
if (denseEmbedding?.provider !== "local") {
  throw new Error("Source recall validation requires a local OpenViking dense embedding provider");
}
const denseEmbeddingKeys = ["cache_dir", "dimension", "input", "model", "provider"];
if (JSON.stringify(Object.keys(denseEmbedding).sort()) !== JSON.stringify(denseEmbeddingKeys)) {
  throw new Error("Source recall validation base dense embedding contains unsupported fields");
}
const effectiveDenseEmbedding = Object.fromEntries(
  denseEmbeddingKeys.map((key) => [key, denseEmbedding[key]]),
);
const runId = process.env.PCR_RUN_ID ?? `source-recall-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/source-recall", runId);
const evidencePath = join(root, "validation/evidence/source-recall.json");
mkdirSync(artifactRoot, { recursive: true });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitForValue(readValue, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error("Timed out waiting for validation observation");
}

async function closeServerWithDeadline(server, label, timeoutMs = 5_000) {
  let timeout;
  const closed = new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  const expired = new Promise((_, rejectClose) => {
    timeout = setTimeout(() => {
      server.closeAllConnections();
      rejectClose(new Error(`${label} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
  });
  try {
    await Promise.race([closed, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function parseJsonl(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value ? value.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
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
  SessionManager,
  buildContextEntries,
  convertToLlm,
  sessionEntryToContextMessages,
} = await import(pathToFileURL(join(locatePiDist(), "index.js")).href);

/** 与扩展 index.ts 使用同一宿主转换的 PiProtocolProfile。 */
const profile = {
  id: "pi-provider-protocol-v1",
  contextEntries: (entries, leafId) => buildContextEntries([...entries], leafId),
  providerMessages: (entry) => convertToLlm(sessionEntryToContextMessages(entry)),
};

function sessionIdentity(manager) {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Validation session has no persistent identity");
  return { sessionId: manager.getSessionId(), sessionFile };
}

function snapshot(manager) {
  return {
    ...sessionIdentity(manager),
    leafId: manager.getLeafId(),
    entries: manager.getBranch(),
  };
}

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

async function expectFailure(action) {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}


async function validateIndexCoordination() {
  const route = { sessionId: "coordination", sessionFile: "/coordination.jsonl", leafId: null, entries: [] };
  const coordinator = {};
  const starts = [];
  const releases = [];
  const indexes = new SessionSourceIndexCoordinator(async (_coordinator, _snapshot, trigger, signal) => {
    starts.push(trigger);
    await new Promise((resolveRun, rejectRun) => {
      releases.push(resolveRun);
      signal.addEventListener("abort", () => rejectRun(signal.reason), { once: true });
    });
  });
  indexes.scheduleBackground(coordinator, route, "session_start");
  let firstSettled = false;
  let sharedSettled = false;
  const first = indexes.synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 1_000)
    .finally(() => { firstSettled = true; });
  const shared = indexes.synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 1_000)
    .finally(() => { sharedSettled = true; });
  const pendingRequiredShared = starts.length === 1;
  releases.shift()?.();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const requiredStartedAfterBackground = starts.join(",") === "session_start,recall";
  const waitsForCompleteRound = !firstSettled && !sharedSettled;
  const next = indexes.synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 1_000);
  const nextShared = indexes.synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 1_000);
  releases.shift()?.();
  await Promise.all([first, shared]);
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const postStartInvocationQueued = starts.join(",") === "session_start,recall,recall";
  releases.shift()?.();
  await Promise.all([next, nextShared]);
  indexes.shutdown();

  let runningCancelled = false;
  const timeoutIndexes = new SessionSourceIndexCoordinator(async (_coordinator, _snapshot, _trigger, signal) => {
    await new Promise((_resolveRun, rejectRun) => {
      signal.addEventListener("abort", () => {
        runningCancelled = true;
        rejectRun(signal.reason);
      }, { once: true });
    });
  });
  let timeoutExplicit = false;
  try {
    await Promise.all([
      timeoutIndexes.synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 20),
      sleep(30),
    ]);
  } catch (error) {
    timeoutExplicit = error instanceof Error && error.message.includes("still being prepared");
  } finally {
    timeoutIndexes.shutdown();
  }

  let shutdownRejectedWaiter = false;
  const shutdownIndexes = new SessionSourceIndexCoordinator(async () => new Promise(() => {}));
  const shutdownWait = shutdownIndexes.synchronizeAfterInvocation(
    coordinator,
    route,
    new AbortController().signal,
    1_000,
  );
  shutdownIndexes.shutdown();
  try {
    await shutdownWait;
  } catch (error) {
    shutdownRejectedWaiter = error instanceof Error && error.message.includes("stopped");
  }

  const queuedStarts = [];
  let releaseQueuedBackground;
  const queuedIndexes = new SessionSourceIndexCoordinator(async (_coordinator, _snapshot, trigger) => {
    queuedStarts.push(trigger);
    if (trigger === "session_start") {
      await new Promise((resolveRun) => { releaseQueuedBackground = resolveRun; });
    }
  });
  queuedIndexes.scheduleBackground(coordinator, route, "session_start");
  const queuedAbort = new AbortController();
  const queuedWait = queuedIndexes.synchronizeAfterInvocation(coordinator, route, queuedAbort.signal, 1_000);
  queuedAbort.abort(new Error("queued recall cancelled"));
  const queuedCancellationExplicit = await expectFailure(() => queuedWait);
  releaseQueuedBackground?.();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const cancelledPendingRemoved = queuedCancellationExplicit && queuedStarts.join(",") === "session_start";
  queuedIndexes.shutdown();

  const synchronousFailureRejected = await expectFailure(() =>
    new SessionSourceIndexCoordinator(() => { throw new Error("synchronous index failure"); })
      .synchronizeAfterInvocation(coordinator, route, new AbortController().signal, 1_000)
  );


  const backlogStarts = [];
  const backlogReleases = [];
  const backlogIndexes = new SessionSourceIndexCoordinator(async (_coordinator, _snapshot, trigger) => {
    backlogStarts.push(trigger);
    await new Promise((resolveRun) => backlogReleases.push(resolveRun));
  });
  backlogIndexes.scheduleBackground(coordinator, { ...route, leafId: "running" }, "session_start");
  for (let index = 1; index <= 4; index += 1) {
    backlogIndexes.scheduleBackground(coordinator, { ...route, leafId: `leaf-${index}` }, `turn-${index}`);
  }
  const prioritized = backlogIndexes.synchronizeAfterInvocation(
    coordinator,
    { ...route, leafId: "leaf-4" },
    new AbortController().signal,
    1_000,
  );
  backlogReleases.shift()?.();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const requiredPrioritizedOverBackground = backlogStarts.join(",") === "session_start,recall";
  backlogReleases.shift()?.();
  await prioritized;
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const backgroundBacklogCollapsed = backlogStarts.join(",") === "session_start,recall,turn-4";
  backlogReleases.shift()?.();
  backlogIndexes.shutdown();


  const returnStarts = [];
  const returnReleases = [];
  const returnIndexes = new SessionSourceIndexCoordinator(async (_coordinator, snapshot) => {
    returnStarts.push(snapshot.leafId);
    await new Promise((resolveRun) => returnReleases.push(resolveRun));
  });
  returnIndexes.scheduleBackground(coordinator, { ...route, leafId: "route-a" }, "turn-a");
  returnIndexes.scheduleBackground(coordinator, { ...route, leafId: "route-b" }, "turn-b");
  returnIndexes.scheduleBackground(coordinator, { ...route, leafId: "route-a" }, "return-a");
  returnReleases.shift()?.();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  const returnToRunningRouteDropsStaleBackground = returnStarts.join(",") === "route-a";
  returnIndexes.shutdown();
  const abortController = new AbortController();
  const abortRecall = Object.create(OpenVikingSourceRecall.prototype);
  let traversedSources = 0;
  abortRecall.ensureSource = async () => {
    traversedSources += 1;
    abortController.abort(new Error("stop source traversal"));
    throw abortController.signal.reason;
  };
  const abortRecords = ["one", "two", "three"].map((entryId) => ({
    format: "message-source-v1",
    normalizationVersion: profile.id,
    source: { sessionId: "coordination", entryId },
    projection: {
      kind: "message-source",
      id: entryId,
      parentId: null,
      role: "user",
      timestamp: new Date(0).toISOString(),
      taskContent: [{ type: "text", text: entryId }],
      completion: undefined,
      taskContentHash: "abort-traversal-fixture",
      authorityHash: "abort-traversal-fixture",
    },
  }));
  const abortedSynchronizationRejected = await expectFailure(() =>
    abortRecall.synchronize(abortRecords, abortController.signal)
  );
  const abortedSynchronizationStopsTraversal = abortedSynchronizationRejected && traversedSources === 1;
  const checks = {
    abortedSynchronizationStopsTraversal,
    backgroundBacklogCollapsed,
    pendingRequiredShared,
    requiredStartedAfterBackground,
    waitsForCompleteRound,
    postStartInvocationQueued,
    timedOutSynchronizationCancelled: timeoutExplicit && runningCancelled,
    shutdownRejectedWaiter,
    cancelledPendingRemoved,
    synchronousFailureRejected,
    requiredPrioritizedOverBackground,
    returnToRunningRouteDropsStaleBackground,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
async function openVikingHealth(url, timeoutMs = 1_000) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`OpenViking health failed: ${response.status}`);
  const health = await response.json();
  if (!health.healthy || health.version !== expectedOpenVikingVersion) {
    throw new Error(`Source recall validation requires OpenViking ${expectedOpenVikingVersion}; found ${health.version ?? "unknown"}`);
  }
  return health;
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function startControlledOpenViking() {
  const serverPath = join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/openviking-server.exe" : "bin/openviking-server",
  );
  if (!existsSync(serverPath)) {
    throw new Error("OpenViking is not installed; run node scripts/install-dependencies.mjs");
  }
  const port = await availableLoopbackPort();
  const effectiveConfig = {
    default_account: openVikingConfig.default_account,
    default_user: openVikingConfig.default_user,
    storage: { workspace: join(artifactRoot, "openviking-data") },
    embedding: { dense: effectiveDenseEmbedding },
    vlm: {},
    memory: {
      extraction_enabled: false,
      session_skill_extraction_enabled: false,
      eager_prefetch: false,
      link_enabled: false,
      session_auto_commit: { default_enabled: false, idle_enabled: false },
    },
    retrieval: { enable_intent: false },
    enable_watch_scheduler: false,
    server: { host: "127.0.0.1", port, agent_evolution: { enabled: false } },
  };
  const effectiveConfigEvidence = {
    defaultAccount: effectiveConfig.default_account,
    defaultUser: effectiveConfig.default_user,
    storageWorkspace: relative(root, effectiveConfig.storage.workspace).split("\\").join("/"),
    embedding: { dense: effectiveDenseEmbedding },
    vlmEnabled: Object.keys(effectiveConfig.vlm).length > 0,
    memory: effectiveConfig.memory,
    retrieval: effectiveConfig.retrieval,
    watchSchedulerEnabled: effectiveConfig.enable_watch_scheduler,
    server: effectiveConfig.server,
  };
  const effectiveConfigPath = join(artifactRoot, "openviking-config.json");
  writeJson(effectiveConfigPath, effectiveConfig);
  const logs = [];
  let processError;
  const childHome = join(artifactRoot, "openviking-home");
  const childTemp = join(artifactRoot, "openviking-tmp");
  mkdirSync(childHome, { recursive: true });
  mkdirSync(childTemp, { recursive: true });
  const childEnvironment = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    HOME: childHome,
    USERPROFILE: childHome,
    TMPDIR: childTemp,
    TEMP: childTemp,
    TMP: childTemp,
    LANG: process.env.LANG ?? "C.UTF-8",
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    PYTHONUNBUFFERED: "1",
  }).filter(([, value]) => value !== undefined));
  const child = spawn(serverPath, ["--config", effectiveConfigPath], {
    cwd: root,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const appendLog = (chunk) => {
    logs.push(Buffer.from(chunk));
    while (logs.reduce((size, value) => size + value.length, 0) > 1024 * 1024) logs.shift();
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.on("error", (error) => { processError = error; });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  const stop = async () => {
    if (!hasExited()) child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
    if (!hasExited()) {
      child.kill("SIGKILL");
      await exited;
    }
    writeFileSync(join(artifactRoot, "openviking-server.log"), Buffer.concat(logs));
  };
  const url = `http://127.0.0.1:${port}`;
  let health;
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    if (processError || hasExited()) break;
    try {
      health = await openVikingHealth(url, Math.max(1, Math.min(1_000, startupDeadline - Date.now())));
      break;
    } catch {
      const remainingMs = startupDeadline - Date.now();
      if (remainingMs > 0) await sleep(Math.min(250, remainingMs));
    }
  }
  if (!health) {
    await stop();
    throw new Error(
      `Controlled OpenViking failed to start: ${processError?.message ?? Buffer.concat(logs).toString("utf8").slice(-4_000)}`,
    );
  }
  return {
    url,
    health,
    effectiveConfigPath,
    effectiveConfig: effectiveConfigEvidence,
    effectiveConfigSha256: sha256(JSON.stringify(effectiveConfigEvidence)),
    stop,
  };
}

async function startRecordingProxy(targetUrl) {
  const requests = [];
  let resourceBlock;
  let failNextFind = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const record = {
      method: request.method,
      path: request.url,
      at: new Date().toISOString(),
      requestJson: undefined,
      responseJson: undefined,
    };
    if (request.headers["content-type"]?.includes("application/json") && body.length > 0) {
      record.requestJson = JSON.parse(body.toString("utf8"));
    }
    requests.push(record);
    if (request.method === "POST" && request.url === "/api/v1/resources" && resourceBlock) {
      if (resourceBlock.precedingRequests > 0) {
        resourceBlock.precedingRequests -= 1;
      } else {
        const activeBlock = resourceBlock;
        record.injectedBlock = true;
        await activeBlock.wait;
        if (resourceBlock === activeBlock) resourceBlock = undefined;
      }
    }
    if (request.method === "POST" && request.url === "/api/v1/search/find" && failNextFind) {
      failNextFind = false;
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "error", error: { message: "injected find failure" } }));
      return;
    }
    try {
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      const upstream = await fetch(`${targetUrl}${request.url}`, {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      let result = Buffer.from(await upstream.arrayBuffer());
      if (upstream.headers.get("content-type")?.includes("application/json")) {
        record.responseJson = JSON.parse(result.toString("utf8"));
        if (request.method === "POST" && request.url === "/api/v1/resources" && record.responseJson?.result) {
          delete record.responseJson.result.queue_status;
          result = Buffer.from(JSON.stringify(record.responseJson));
        }
      }
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (name.toLowerCase() !== "content-length") response.setHeader(name, value);
      }
      response.end(result);
    } catch (error) {
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "error", error: { message: String(error) } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    blockNextResource(precedingRequests = 0) {
      let release;
      const wait = new Promise((resolveBlock) => { release = resolveBlock; });
      resourceBlock = { precedingRequests, wait, release };
    },
    releaseBlockedResource() {
      resourceBlock?.release();
    },
    failNextFind() {
      failNextFind = true;
    },
    close: () => closeServerWithDeadline(server, "recording proxy"),
  };
}

async function startFailureServer() {
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "error", error: { message: "injected backend failure" } }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function startEmptySearchServer(resources = []) {
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", result: { resources } }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function validateRecallCore(proxy) {
  const caseDir = join(artifactRoot, "core");
  const memory = new FileLongTermMemory(join(caseDir, "archive"));
  const first = SessionManager.create(caseDir, join(caseDir, "session-a"));
  const second = SessionManager.create(caseDir, join(caseDir, "session-b"));
  const commonId = first.appendMessage(userMessage("The unique early sentinel is COBALT-7319 and the exact control port is 43127."));
  const routePoint = first.getLeafId();
  const branchAId = first.appendMessage(userMessage("Branch A selected SQLite as the durable database."));
  const staleBranchIds = [branchAId];
  for (let index = 0; index < 40; index += 1) {
    staleBranchIds.push(first.appendMessage(userMessage(
      `Branch A obsolete database decision ${index}: SQLite remained selected for durable storage.`,
    )));
  }
  const firstCoordinator = new SessionMemoryCoordinator(sessionIdentity(first), memory, profile);
  await firstCoordinator.archiveCurrentRoute(snapshot(first));
  const routeA = snapshot(first);
  const sourcesA = await firstCoordinator.listCurrentSources(routeA);

  first.branch(routePoint);
  const branchBId = first.appendMessage(userMessage("Branch B selected PostgreSQL as the durable database."));
  const longId = first.appendMessage(userMessage(`LONG-EDGE-4410 ${"middle ".repeat(2_000)} TAIL-EDGE-9920`));
  await firstCoordinator.archiveCurrentRoute(snapshot(first));
  const routeB = snapshot(first);
  const sourcesB = await firstCoordinator.listCurrentSources(routeB);

  second.appendMessage(userMessage("Another session uses MARIGOLD-9902 and exact port 59881."));
  const secondCoordinator = new SessionMemoryCoordinator(sessionIdentity(second), memory, profile);
  await secondCoordinator.archiveCurrentRoute(snapshot(second));
  const sourcesSecond = await secondCoordinator.listCurrentSources(snapshot(second));

  const namespace = `viking://resources/pi-context-memory-validation-${sha256(runId).slice(0, 16)}`;
  const recall = new OpenVikingSourceRecall(proxy.url, undefined, 30_000, namespace);
  await recall.synchronize(sourcesA);
  await recall.synchronize(sourcesB);
  await recall.synchronize(sourcesSecond);
  const initialResourceRequestCount = proxy.requests
    .filter((request) => request.method === "POST" && request.path === "/api/v1/resources")
    .length;

  const sentinel = await recall.searchCurrent(routeB, sourcesB, "exact early sentinel and control port", 5);
  const database = await recall.searchCurrent(routeB, sourcesB, "durable database selected on the active branch", 5);
  const long = await recall.searchCurrent(routeB, sourcesB, "LONG EDGE 4410 TAIL EDGE 9920", 5);
  const emptyIdentity = { sessionId: randomUUID(), sessionFile: "/missing/session.jsonl" };
  const empty = await recall.searchCurrent(emptyIdentity, [], "nothing", 5);
  const emptySearchServer = await startEmptySearchServer();
  const rankedEmpty = await new OpenVikingSourceRecall(emptySearchServer.url, undefined, 1_000, namespace)
    .searchCurrent(routeB, sourcesB, "deliberately empty backend result", 5);
  await emptySearchServer.close();
  const oldSource = await firstCoordinator.resolveCurrentSource(routeB, branchAId);
  const longSource = await firstCoordinator.resolveCurrentSource(routeB, longId);
  const expanded = longSource ? expandSource(longSource.projection, 1_000) : { content: "", truncated: false };
  const resourceRequestsBeforeRecovery = proxy.requests
    .filter((request) => request.method === "POST" && request.path === "/api/v1/resources")
    .length;
  const deleteResponse = await fetch(
    `${proxy.url}/api/v1/fs?uri=${encodeURIComponent(recall.sessionUri(routeB))}&recursive=true`,
    { method: "DELETE" },
  );
  if (!deleteResponse.ok) {
    throw new Error(`OpenViking resource cleanup failed: ${deleteResponse.status} ${await deleteResponse.text()}`);
  }
  const competingRecall = new OpenVikingSourceRecall(proxy.url, undefined, 30_000, namespace);
  const concurrentRebuild = await Promise.allSettled([
    recall.synchronize(sourcesB),
    competingRecall.synchronize(sourcesB),
  ]);
  const concurrentRebuildConverged = concurrentRebuild.every((result) => result.status === "fulfilled");
  const recovered = await recall.searchCurrent(routeB, sourcesB, "exact early sentinel and control port", 5);

  const modified = structuredClone(sourcesB.find((source) => source.source.entryId === commonId));
  modified.projection.taskContent = [{ type: "text", text: "tampered source" }];
  const reopened = new OpenVikingSourceRecall(proxy.url, undefined, 30_000, namespace);
  const immutableMismatchRejected = await expectFailure(() => reopened.synchronize([modified]));
  const original = sourcesB.find((source) => source.source.entryId === commonId);
  if (!original) throw new Error(`Current route source ${commonId} is missing`);
  const concurrentProbe = new OpenVikingSourceRecall(proxy.url, undefined, 30_000, namespace);
  const concurrentMismatch = await Promise.allSettled([
    concurrentProbe.synchronize([original]),
    concurrentProbe.synchronize([modified]),
  ]);
  const concurrentMismatchRejected =
    concurrentMismatch[0].status === "fulfilled"
    && concurrentMismatch[1].status === "rejected";
  const authorityMismatchRejected = await expectFailure(() =>
    new SessionMemoryCoordinator(routeB, { readSource: async () => modified }, profile)
      .listCurrentSources({ ...routeB, leafId: commonId, entries: [first.getEntry(commonId)] }),
  );
  const insecureRemoteRejected = (await Promise.all([
    "http://example.com:1933",
    "http://127.attacker.example:1933",
    "http://127.0.0.1.nip.io:1933",
  ].map((url) => expectFailure(async () => {
    new OpenVikingSourceRecall(url, undefined, 1_000, namespace);
  })))).every(Boolean);

  const failureServer = await startFailureServer();
  const backendFailureDistinct = await expectFailure(() =>
    new OpenVikingSourceRecall(failureServer.url, undefined, 1_000, namespace)
      .searchCurrent(routeB, sourcesB, "sentinel", 5),
  );
  await failureServer.close();
  const malformedSearchServer = await startEmptySearchServer([null, { uri: 42, score: "invalid" }]);
  const malformedSearchRejected = await expectFailure(() =>
    new OpenVikingSourceRecall(malformedSearchServer.url, undefined, 1_000, namespace)
      .searchCurrent(routeB, sourcesB, "malformed candidates", 5),
  );
  await malformedSearchServer.close();

  const resourceRequests = proxy.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/resources");
  const completedResourceRequests = resourceRequests.filter((request) => request.responseJson?.result?.status === "success");
  const databaseRequest = proxy.requests.find((request) =>
    request.method === "POST"
    && request.path === "/api/v1/search/find"
    && request.requestJson?.query === "durable database selected on the active branch"
  );
  const currentRouteUris = new Set(sourcesB.map((source) => recall.sourceUri(routeB, source.source.entryId)));
  const branchTargets = databaseRequest?.requestJson?.target_uri;
  const uniqueSourceUris = new Set(
    [...sourcesA, ...sourcesB, ...sourcesSecond]
      .map((source) => recall.sourceUri(source.source, source.source.entryId)),
  );
  const checks = {
    localEmbeddingConfigured: openVikingConfig.embedding?.dense?.provider === "local",
    vectorsOnly: resourceRequests.length > 0 && resourceRequests.every((request) => request.requestJson?.processing_mode === "vectors_only"),
    stableNoSplitResources: resourceRequests.every((request) => request.requestJson?.args?.parse_mode === "no_split"),
    idempotentResources: initialResourceRequestCount === uniqueSourceUris.size,
    concurrentMismatchRejected,
    concurrentRebuildConverged,
    deletedIndexRestored:
      resourceRequests.length > resourceRequestsBeforeRecovery
      && recovered.hits.some((hit) => hit.entryId === commonId && hit.preview.includes("COBALT-7319")),
    resourceDiagnosticsOptional: completedResourceRequests.length > 0
      && completedResourceRequests.every((request) => request.responseJson?.result?.queue_status === undefined)
      && recovered.hits.some((hit) => hit.entryId === commonId),
    noContentWrite: !proxy.requests.some((request) => request.path === "/api/v1/content/write"),
    sessionIsolation: sentinel.hits.every((hit) => !hit.preview.includes("MARIGOLD-9902") && !hit.preview.includes("59881")),
    branchFiltering: database.hits.some((hit) => hit.entryId === branchBId)
      && database.hits.every((hit) => hit.entryId !== branchAId),
    staleBranchCandidatesExcludedBeforeRanking: staleBranchIds.length > 25
      && Array.isArray(branchTargets)
      && branchTargets.length === currentRouteUris.size
      && branchTargets.every((uri) => currentRouteUris.has(uri))
      && database.backendCandidates <= currentRouteUris.size,
    oldSourceRejected: oldSource === undefined,
    sourceRestoration: sentinel.hits.some((hit) => hit.entryId === commonId && hit.preview.includes("COBALT-7319")),
    searchBounded: sentinel.hits.length <= 5 && long.hits.every((hit) => hit.preview.length <= 1_200),
    expansionBounded: expanded.truncated && expanded.content.length <= 1_000,
    noSourcesShortCircuit: empty.hits.length === 0 && empty.backendCandidates === 0,
    emptyResultDistinct: rankedEmpty.hits.length === 0 && rankedEmpty.backendCandidates === 0,
    backendFailureDistinct,
    malformedSearchRejected,
    immutableMismatchRejected,
    authorityMismatchRejected,
    insecureRemoteRejected,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    counts: {
      indexedResources: resourceRequests.length,
      sentinelBackendCandidates: sentinel.backendCandidates,
      sentinelCurrentRouteCandidates: sentinel.currentRouteCandidates,
      branchBackendCandidates: database.backendCandidates,
      branchCurrentRouteCandidates: database.currentRouteCandidates,
    },
    sourceHashes: {
      common: sourcesB.find((source) => source.source.entryId === commonId).entrySha256,
      branchB: sourcesB.find((source) => source.source.entryId === branchBId).entrySha256,
    },
  };
}


const startedAt = new Date().toISOString();
const coordination = await validateIndexCoordination();
const controlledOpenViking = await startControlledOpenViking();
const health = controlledOpenViking.health;
let proxy;
let cleanupPromise;
const cleanup = () => {
  cleanupPromise ??= (async () => {
    try {
      proxy?.releaseBlockedResource();
      if (proxy) await proxy.close();
    } finally {
      await controlledOpenViking.stop();
    }
  })();
  return cleanupPromise;
};
const stopForSignal = (exitCode) => { void cleanup().finally(() => process.exit(exitCode)); };
const handleSigint = () => stopForSignal(130);
const handleSigterm = () => stopForSignal(143);
process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);
let core;
try {
  proxy = await startRecordingProxy(controlledOpenViking.url);
  core = await validateRecallCore(proxy);
} finally {
  process.removeListener("SIGINT", handleSigint);
  process.removeListener("SIGTERM", handleSigterm);
  await cleanup();
}
assertImplementationEvidenceUnchanged(root, "source-recall", implementation);
const checks = { ...coordination.checks, ...core.checks };
const summary = {
  schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
  generatedBy: "scripts/validate-source-recall.mjs",
  scope,
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  piVersion,
  nodeVersion: process.versions.node,
  openVikingVersion: health.version,
  openVikingConfig: {
    templatePath: openVikingConfigPath.startsWith(`${root}/`) ? openVikingConfigPath.slice(root.length + 1) : openVikingConfigPath,
    templateSha256: sha256(readFileSync(openVikingConfigPath)),
    effective: controlledOpenViking.effectiveConfig,
    effectiveSha256: controlledOpenViking.effectiveConfigSha256,
    controlledByRunner: true,
    denseEmbeddingProvider: openVikingConfig.embedding.dense.provider,
  },
  implementation,
  passed: coordination.passed && core.passed && Object.values(checks).every(Boolean),
  checks,
  coordination,
  core,
  limitations: [
    "The local scope covers source coordination and OpenViking retrieval with local dense embeddings.",
    "Automatic Working Memory and context adoption have separate local evidence; real Provider task quality and complete API cost remain in the paired experiment.",
    "OpenViking LLM, VLM, memory extraction, and Working Memory remain disabled in this runner.",
  ],
};
writeJson(join(artifactRoot, "summary.json"), summary);

const stableEvidence = {
  schemaVersion: summary.schemaVersion,
  generatedBy: summary.generatedBy,
  scope: summary.scope,
  runId: summary.runId,
  recordedAt: summary.completedAt,
  piVersion,
  nodeVersion: summary.nodeVersion,
  openVikingVersion: health.version,
  openVikingConfig: summary.openVikingConfig,
  implementation,
  passed: summary.passed,
  checks,
  candidateCounts: core.counts,
  sourceHashes: core.sourceHashes,
  limitations: summary.limitations,
};
if (stableEvidence.passed) replaceJson(evidencePath, stableEvidence);
console.error(`current evidence: ${evidencePath}`);
console.log(JSON.stringify(summary, null, 2));
console.error(`raw evidence: ${artifactRoot}`);
if (!summary.passed) process.exitCode = 1;
