#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import { assertValidationPiVersion } from "./validation-suite.mjs";

import {
  FileLongTermMemory,
  isMessageSourceRecord,
} from "../.pi/extensions/pi-context-memory/long-term-memory.ts";
import { expandSource } from "../.pi/extensions/pi-context-memory/recall-and-provenance.ts";
import { SessionMemoryCoordinator } from "../.pi/extensions/pi-context-memory/session-memory-coordination.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-source-archive.mjs");
const scope = "local";
const implementation = captureImplementationEvidence(root, "source-archive");
const piVersion = assertValidationPiVersion(root);

const runId = process.env.PCR_RUN_ID ?? `source-archive-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/source-archive", runId);
const evidencePath = join(root, "validation/evidence/source-archive.json");
const extensionPath = join(root, ".pi/extensions/pi-context-memory/index.ts");
const model = "archive-validation/local";
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

function parseJsonl(path) {
  const value = readFileSync(path, "utf8").trim();
  return value ? value.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function sessionIdentity(manager) {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Validation SessionManager did not persist a session file");
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

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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

/** 当前 suite 所选 PiProtocolProfile；与扩展 index.ts 使用同一宿主转换。 */
const profile = {
  id: "pi-provider-protocol-v1",
  contextEntries: (entries, leafId) => buildContextEntries([...entries], leafId),
  providerMessages: (entry) => convertToLlm(sessionEntryToContextMessages(entry)),
};

function coordinatorFor(identity, memory) {
  return new SessionMemoryCoordinator(identity, memory, profile);
}

function projectionsOf(records) {
  return records.map((record) => record.projection);
}

function archivedText(records) {
  return JSON.stringify(records);
}

/**
 * Provider 基线行为探针：固定当前 Pi 版本的转换语义。
 * profile 只有在本探针重新通过后才能继续使用（docs/modules/pi-integration.md §2）。
 */
function validateProviderBaseline() {
  const ts = Date.now();
  const one = (message) => convertToLlm([message]);
  const roles = (out) => out.map((message) => message.role).join("+");

  const userPreserved = roles(one({ role: "user", content: "u", timestamp: ts })) === "user";
  const assistantPreserved = roles(one({
    role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "endTurn", timestamp: ts,
  })) === "assistant";
  const toolResultPreserved = roles(one({
    role: "toolResult", toolCallId: "c", toolName: "t",
    content: [{ type: "text", text: "r" }], isError: false, timestamp: ts,
  })) === "toolResult";
  const bashBecomesUser = roles(one({
    role: "bashExecution", command: "ls", output: "o", exitCode: 0,
    cancelled: false, truncated: false, timestamp: ts,
  })) === "user";
  const excludedBashDropped = one({
    role: "bashExecution", command: "x", output: "BASELINE-EXCLUDED", exitCode: 0,
    cancelled: false, truncated: false, excludeFromContext: true, timestamp: ts,
  }).length === 0;
  const customBecomesUser = (() => {
    const out = one({
      role: "custom", customType: "any-foreign", content: "c",
      display: true, details: { BASELINE_DETAILS: 1 }, timestamp: ts,
    });
    return roles(out) === "user" && !JSON.stringify(out).includes("BASELINE_DETAILS");
  })();
  const summariesBecomeUser = roles(one({
    role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: ts,
  })) === "user" && roles(one({
    role: "branchSummary", summary: "s", fromId: "x", timestamp: ts,
  })) === "user";
  const unknownRoleDropped = one({ role: "futureUnknownRole", content: "BASELINE-UNKNOWN", timestamp: ts }).length === 0;
  const nonContextEntriesDropped = [
    { id: "p1", parentId: null, type: "thinking_level_change", timestamp: new Date(ts).toISOString(), thinkingLevel: "off" },
    { id: "p2", parentId: "p1", type: "model_change", timestamp: new Date(ts).toISOString(), provider: "p", modelId: "m" },
    { id: "p3", parentId: "p2", type: "custom", timestamp: new Date(ts).toISOString(), customType: "e", data: { BASELINE_EXT: 1 } },
  ].every((entry) => sessionEntryToContextMessages(entry).length === 0);

  const checks = {
    userPreserved,
    assistantPreserved,
    toolResultPreserved,
    bashBecomesUser,
    excludedBashDropped,
    customBecomesUser,
    summariesBecomeUser,
    unknownRoleDropped,
    nonContextEntriesDropped,
  };
  return { passed: Object.values(checks).every(Boolean), checks, profileId: profile.id };
}

function validateUnpersistedSession() {
  const caseDir = join(artifactRoot, "unpersisted-session");
  const observationLog = join(caseDir, "observations.jsonl");
  const archivePath = join(caseDir, "archive");
  mkdirSync(caseDir, { recursive: true });
  const providerGuardPath = join(caseDir, "local-provider.ts");
  writeFileSync(providerGuardPath, `export default function localProvider(pi) {
  pi.registerProvider("archive-validation", {
    name: "Archive Validation",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{
      id: "local",
      name: "Local Validation",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    }],
  });
}\n`, "utf8");
  const isolatedAgentDir = join(caseDir, "pi-agent");
  const isolatedHome = join(caseDir, "home");
  mkdirSync(isolatedAgentDir, { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  const isolatedEnv = {
    ...process.env,
    HOME: isolatedHome,
    PI_CODING_AGENT_DIR: isolatedAgentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PCR_RUN_ID: runId,
    PCR_OBSERVATION_LOG: observationLog,
    PCR_ARCHIVE_DIR: archivePath,
  };
  delete isolatedEnv.OPENROUTER_API_KEY;
  const result = spawnSync("pi", [
    "--mode", "rpc",
    "--session-dir", join(caseDir, "session"),
    "--model", model,
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--extension", extensionPath,
    "--extension", providerGuardPath,
    "--no-tools",
  ], {
    cwd: root,
    env: isolatedEnv,
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  const observations = parseJsonl(observationLog);
  const noProviderRequests = !observations.some((row) => row.type === "before_provider_request");
  const unpersistedSessionSkipped = (
    result.status === 0
    && observations.some((row) => row.type === "session_start")
    && observations.some((row) => row.type === "session_shutdown")
    && noProviderRequests
    && !observations.some((row) => row.type === "archive_complete" || row.type === "archive_error")
    && !existsSync(archivePath)
  );
  return {
    passed: unpersistedSessionSkipped && noProviderRequests,
    checks: { noProviderRequests, unpersistedSessionSkipped },
  };
}


async function validateStorageAndCoordination() {
  const caseDir = join(artifactRoot, "coordination");
  const archiveRoot = join(caseDir, "archive");
  const memory = new FileLongTermMemory(archiveRoot);
  const first = SessionManager.create(caseDir, join(caseDir, "session-a"));
  const second = SessionManager.create(caseDir, join(caseDir, "session-b"));

  first.appendMessage(userMessage("conflict-key=SESSION_A"));
  second.appendMessage(userMessage("conflict-key=SESSION_B"));
  const firstIdentity = sessionIdentity(first);
  const secondIdentity = sessionIdentity(second);
  const firstCoordinator = coordinatorFor(firstIdentity, memory);
  const secondCoordinator = coordinatorFor(secondIdentity, memory);
  await firstCoordinator.archiveCurrentRoute(snapshot(first));
  await secondCoordinator.archiveCurrentRoute(snapshot(second));

  const firstSources = await firstCoordinator.listCurrentSources(snapshot(first));
  const secondSources = await secondCoordinator.listCurrentSources(snapshot(second));
  const sessionIsolation = (
    firstSources.length === 1
    && secondSources.length === 1
    && JSON.stringify(firstSources).includes("SESSION_A")
    && !JSON.stringify(firstSources).includes("SESSION_B")
    && JSON.stringify(secondSources).includes("SESSION_B")
    && !JSON.stringify(secondSources).includes("SESSION_A")
    && await expectFailure(() => firstCoordinator.listCurrentSources(snapshot(second)))
  );

  const commonId = first.getLeafId();
  if (!commonId) throw new Error("Missing common branch entry");
  const routeAId = first.appendMessage(userMessage("route=A"));
  const routeASnapshot = snapshot(first);
  await firstCoordinator.archiveCurrentRoute(routeASnapshot);
  first.branch(commonId);
  const routeBId = first.appendMessage(userMessage("route=B"));
  const routeBSnapshot = snapshot(first);
  await firstCoordinator.archiveCurrentRoute(routeBSnapshot);

  const historical = await memory.listSources(firstIdentity);
  const current = await firstCoordinator.listCurrentSources(routeBSnapshot);
  const branchFiltering = (
    historical.some((record) => record.source.entryId === routeAId)
    && historical.some((record) => record.source.entryId === routeBId)
    && !current.some((record) => record.source.entryId === routeAId)
    && current.some((record) => record.source.entryId === routeBId)
    && await firstCoordinator.resolveCurrentSource(routeBSnapshot, routeAId) === undefined
  );

  // 来源与当前 Pi entry 经同版本规范化后，task-content、完成状态与两个哈希精确一致。
  const liveProjections = new Map(
    firstCoordinator.projectCurrentRoute(routeBSnapshot).projections
      .filter((projection) => projection.kind === "message-source")
      .map((projection) => [projection.id, projection]),
  );
  const restored = await Promise.all([...liveProjections.keys()].map((entryId) =>
    firstCoordinator.resolveCurrentSource(routeBSnapshot, entryId),
  ));
  const messageSourceReprojection = restored.length > 0 && restored.every((item) => {
    if (!item || !isMessageSourceRecord(item.record)) return false;
    const live = liveProjections.get(item.record.source.entryId);
    const stored = item.record.projection;
    return Boolean(live)
      && item.record.source.sessionId === firstIdentity.sessionId
      && item.record.source.sessionFile === firstIdentity.sessionFile
      && stored.taskContentHash === live.taskContentHash
      && stored.authorityHash === live.authorityHash
      && JSON.stringify(stored.taskContent) === JSON.stringify(live.taskContent)
      && JSON.stringify(stored.completion ?? null) === JSON.stringify(live.completion ?? null);
  });

  const toolCallId = "call_source_archive_validation";
  first.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: {} }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const toolResultId = first.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "[truncated]" }],
    isError: false,
    timestamp: Date.now(),
  });
  const largeOutput = Buffer.from("large-source-result\n".repeat(8192));
  const largeOutputPath = join(caseDir, "large-output.txt");
  writeFileSync(largeOutputPath, largeOutput);
  const largeSnapshot = snapshot(first);
  const authoritativeToolEntry = first.getEntry(toolResultId);
  authoritativeToolEntry.message.details = { fullOutputPath: largeOutputPath };
  const recoveryCoordinator = coordinatorFor(firstIdentity, memory);
  const archivedLarge = await recoveryCoordinator.archiveCurrentRoute(largeSnapshot);
  const opened = await memory.openFullOutput(firstIdentity, toolResultId);
  const copied = opened ? await consume(opened.stream) : Buffer.alloc(0);
  const toolRecord = await memory.readSource(firstIdentity, toolResultId);
  const completeFullOutput = (
    recoveryCoordinator !== firstCoordinator
    && archivedLarge.archivedFullOutputEntryIds.length === 1
    && archivedLarge.archivedFullOutputEntryIds[0] === toolResultId
    && opened?.ref.size === largeOutput.length
    && opened?.ref.sha256 === sha256(largeOutput)
    && copied.equals(largeOutput)
    // fullOutputRef 只存在于同一份来源记录，不存在第二份 entry metadata
    && Boolean(toolRecord && isMessageSourceRecord(toolRecord) && toolRecord.fullOutputRef)
    && !existsSync(join(archiveRoot, sha256(firstIdentity.sessionId), "large-results", "records"))
    // 本机路径不进入来源记录
    && !archivedText([toolRecord]).includes(largeOutputPath)
  );

  const blobPath = join(
    archiveRoot,
    sha256(firstIdentity.sessionId),
    "large-results",
    "blobs",
    opened.ref.blobId,
  );
  const originalBlob = readFileSync(blobPath);
  writeFileSync(blobPath, Buffer.concat([originalBlob, Buffer.from("corrupt")]));
  const corruptedBlobRejected = await expectFailure(() => memory.openFullOutput(firstIdentity, toolResultId));
  const corruptedBlobBarrierRejected = await expectFailure(() =>
    recoveryCoordinator.archiveCurrentRoute(largeSnapshot));
  writeFileSync(blobPath, originalBlob);

  // 复制失败不得污染已经发布的 fullOutputRef，也不得留下待发布中间态。
  const copyFailureRejected = await expectFailure(() => memory.archiveFullOutput(firstIdentity, {
    entryId: toolResultId,
    toolCallId,
    path: join(caseDir, "missing-full-output.bin"),
  }));
  const reopened = await memory.openFullOutput(firstIdentity, toolResultId);
  const reopenedContent = reopened ? await consume(reopened.stream) : Buffer.alloc(0);
  const pendingBlobs = readdirSync(join(archiveRoot, sha256(firstIdentity.sessionId), "large-results", "blobs"))
    .filter((name) => name.startsWith(".pending"));
  const fullOutputPublicationAtomic = (
    copyFailureRejected
    && reopened?.ref.sha256 === sha256(largeOutput)
    && reopenedContent.equals(largeOutput)
    && pendingBlobs.length === 0
  );

  const timeoutSource = join(caseDir, "timeout-source.bin");
  writeFileSync(timeoutSource, "");
  truncateSync(timeoutSource, 64 * 1024 * 1024);
  const timeoutMemory = new FileLongTermMemory(join(caseDir, "timeout-archive"), 1);
  const timeoutCoordinator = coordinatorFor(firstIdentity, timeoutMemory);
  const timeoutSnapshot = structuredClone(largeSnapshot);
  const timeoutEntry = timeoutSnapshot.entries.find((entry) => entry.id === toolResultId);
  if (timeoutEntry?.message?.details) delete timeoutEntry.message.details.fullOutputPath;
  await timeoutCoordinator.archiveCurrentRoute(timeoutSnapshot);
  const fullOutputCopyTimeoutEnforced = await expectFailure(() =>
    timeoutMemory.archiveFullOutput(firstIdentity, { entryId: toolResultId, toolCallId, path: timeoutSource }),
  );
  rmSync(timeoutSource, { force: true });

  const broken = {
    ...largeSnapshot,
    entries: largeSnapshot.entries.map((entry, index) => index === 1 ? { ...entry, parentId: "not-current-parent" } : entry),
  };
  const invalidRouteRejected = await expectFailure(() => firstCoordinator.archiveCurrentRoute(broken));

  const blockedRoot = join(caseDir, "blocked-root");
  writeFileSync(blockedRoot, "not a directory", "utf8");
  const blockedCoordinator = coordinatorFor(firstIdentity, new FileLongTermMemory(blockedRoot));
  const storageFailurePropagates = await expectFailure(() => blockedCoordinator.archiveCurrentRoute(largeSnapshot));

  return {
    passed: [
      sessionIsolation,
      branchFiltering,
      messageSourceReprojection,
      completeFullOutput,
      corruptedBlobRejected,
      corruptedBlobBarrierRejected,
      fullOutputPublicationAtomic,
      fullOutputCopyTimeoutEnforced,
      invalidRouteRejected,
      storageFailurePropagates,
    ].every(Boolean),
    checks: {
      sessionIsolation,
      branchFiltering,
      messageSourceReprojection,
      completeFullOutput,
      corruptedBlobRejected,
      corruptedBlobBarrierRejected,
      fullOutputPublicationAtomic,
      fullOutputCopyTimeoutEnforced,
      invalidRouteRejected,
      storageFailurePropagates,
    },
    sourceCounts: {
      firstSessionHistorical: historical.length,
      firstSessionCurrentBranch: current.length,
      secondSessionCurrentBranch: secondSources.length,
    },
    fullOutput: { size: largeOutput.length, sha256: sha256(largeOutput) },
  };
}


/**
 * Provider 基线、记忆投影与 summary 边界（docs/validation/source-archive.md §3.3）。
 * 全-text 任意 customType 形成 user-role MessageSource；mixed/image 整单元 opaque；
 * ControlBoundary 无正文；thinking/private details/locator 不进来源。
 */
async function validateProjectionBoundary() {
  const caseDir = join(artifactRoot, "projection-boundary");
  mkdirSync(caseDir, { recursive: true });
  const archiveRoot = join(caseDir, "archive");
  const memory = new FileLongTermMemory(archiveRoot);
  const session = SessionManager.create(caseDir, join(caseDir, "session"));
  const identity = sessionIdentity(session);
  const coordinator = coordinatorFor(identity, memory);

  const firstUserId = session.appendMessage(userMessage("PROBE-USER"));
  session.appendMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "PROBE-THINKING" }, { type: "text", text: "PROBE-ASSISTANT" }],
    stopReason: "endTurn",
    timestamp: Date.now(),
    usage: { input: 1, output: 1 },
  });
  const foreignTextId = session.appendCustomMessageEntry("foreign-extension", "PROBE-FOREIGN-TEXT", true, {
    PROBE_DETAILS: "PROBE-PRIVATE-DETAILS",
  });
  const mixedId = session.appendCustomMessageEntry("foreign-extension", [
    { type: "text", text: "PROBE-MIXED-TEXT" },
    { type: "image", data: "UFJPQkU=", mimeType: "image/png" },
  ], true);
  session.appendCustomEntry("private-extension", { PROBE_EXT: "PROBE-EXTENSION-DATA" });
  session.appendMessage({
    role: "bashExecution", command: "echo", output: "PROBE-EXCLUDED-BASH", exitCode: 0,
    cancelled: false, truncated: false, excludeFromContext: true, timestamp: Date.now(),
  });

  const bashOutputPath = join(caseDir, "bash-full-output.txt");
  writeFileSync(bashOutputPath, "PROBE-BASH-FULL-OUTPUT\n");
  const truncatedBashId = session.appendMessage({
    role: "bashExecution", command: "probe", output: "PROBE-BASH-TAIL", exitCode: 0,
    cancelled: false, truncated: true, fullOutputPath: bashOutputPath, timestamp: Date.now(),
  });

  const orphanResultId = session.appendMessage({
    role: "toolResult", toolCallId: "probe-orphan", toolName: "Read",
    content: [{ type: "text", text: "PROBE-ORPHAN-RESULT" }], isError: false, timestamp: Date.now(),
  });
  const duplicateCallId = session.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "probe-duplicate", name: "Read", arguments: {} },
      { type: "toolCall", id: "probe-duplicate", name: "Shot", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const duplicateResultId = session.appendMessage({
    role: "toolResult", toolCallId: "probe-duplicate", toolName: "Read",
    content: [{ type: "text", text: "PROBE-DUPLICATE-RESULT" }], isError: false, timestamp: Date.now(),
  });

  // ToolBatch：一次调用两个工具，其中一个返回 image，整批必须 opaque。
  const batchCallId = session.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "probe-a", name: "Read", arguments: {} },
      { type: "toolCall", id: "probe-b", name: "Shot", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const batchTextId = session.appendMessage({
    role: "toolResult", toolCallId: "probe-a", toolName: "Read",
    content: [{ type: "text", text: "PROBE-BATCH-TEXT" }], isError: false, timestamp: Date.now(),
  });
  const batchImageId = session.appendMessage({
    role: "toolResult", toolCallId: "probe-b", toolName: "Shot",
    content: [{ type: "image", data: "UFJPQkU=", mimeType: "image/png" }], isError: false, timestamp: Date.now(),
  });
  const missingCallId = session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", name: "Read", arguments: {} }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const missingCallResultId = session.appendMessage({
    role: "toolResult", toolCallId: "probe-missing-id", toolName: "Read",
    content: [{ type: "text", text: "PROBE-MISSING-ID-RESULT" }], isError: false, timestamp: Date.now(),
  });
  const incompleteCallId = session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "probe-incomplete", name: "Read", arguments: {} }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const malformedId = session.appendCustomMessageEntry("foreign-extension", [
    { type: "text", text: "PROBE-MALFORMED-TEXT" },
    7,
  ], true);

  const compactionId = session.appendCompaction("PROBE-COMPACTION-SUMMARY", firstUserId, 42);
  session.appendMessage(userMessage("PROBE-AFTER-COMPACTION"));
  session.branchWithSummary(compactionId, "PROBE-BRANCH-SUMMARY");
  session.appendMessage(userMessage("PROBE-AFTER-BRANCH"));

  const routeSnapshot = snapshot(session);
  await coordinator.archiveCurrentRoute(routeSnapshot);
  const records = await memory.listSources(identity);
  const stored = archivedText(records);
  const byId = new Map(records.map((record) => [record.source.entryId, record]));
  const { projections, providerBaseline } = coordinator.projectCurrentRoute(routeSnapshot);
  const opaque = projections.filter((projection) => projection.kind === "opaque-provider-segment");
  const boundaries = projections.filter((projection) => projection.kind === "control-boundary");
  const bashRecord = byId.get(truncatedBashId);
  const bashFullOutput = await coordinator.readCurrentFullOutput(routeSnapshot, truncatedBashId, 1_000);
  const bashExpansion = bashRecord && isMessageSourceRecord(bashRecord)
    ? expandSource(bashRecord.projection, 1_000, bashFullOutput)
    : undefined;

  const opaqueLocatorPath = join(caseDir, "opaque-full-output.txt");
  writeFileSync(opaqueLocatorPath, "PROBE-OPAQUE-FULL-OUTPUT\n");
  const opaqueLocatorSnapshot = structuredClone(routeSnapshot);
  const opaqueLocatorEntry = opaqueLocatorSnapshot.entries.find((entry) => entry.id === batchImageId);
  opaqueLocatorEntry.message.details = { fullOutputPath: opaqueLocatorPath };
  const opaqueLocatorProjection = coordinator.projectCurrentRoute(opaqueLocatorSnapshot);
  const opaqueLocatorSanitized = opaqueLocatorProjection.fullOutputCandidates.some((candidate) =>
    candidate.entryId === batchImageId && candidate.path === opaqueLocatorPath)
    && !JSON.stringify(opaqueLocatorProjection.providerBaseline).includes(opaqueLocatorPath)
    && !JSON.stringify(opaqueLocatorProjection.projections).includes(opaqueLocatorPath)
    && JSON.stringify(opaqueLocatorProjection.projections).includes(`recall_session read_source ${batchImageId}`);
  const opaqueLocatorBarrierRejected = await expectFailure(() =>
    coordinator.archiveCurrentRoute(opaqueLocatorSnapshot));

  const foreignTextProjected = Boolean(
    byId.get(foreignTextId)
    && isMessageSourceRecord(byId.get(foreignTextId))
    && byId.get(foreignTextId).projection.role === "user"
    && stored.includes("PROBE-FOREIGN-TEXT"),
  );
  const mixedUnitOpaque = !byId.has(mixedId)
    && !byId.has(malformedId)
    && opaque.some((segment) => segment.entryIds.includes(mixedId))
    && opaque.some((segment) => segment.entryIds.includes(malformedId))
    && !stored.includes("PROBE-MIXED-TEXT")
    && !stored.includes("PROBE-MALFORMED-TEXT");
  const bashFullOutputRecoverable = Boolean(
    bashRecord
    && isMessageSourceRecord(bashRecord)
    && bashRecord.fullOutputRef
    && !stored.includes(bashOutputPath)
    && !JSON.stringify(providerBaseline).includes(bashOutputPath)
    && JSON.stringify(providerBaseline).includes(`recall_session read_source ${truncatedBashId}`)
    && JSON.stringify(bashRecord.projection.taskContent).includes(`recall_session read_source ${truncatedBashId}`)
    && bashFullOutput?.content === "PROBE-BASH-FULL-OUTPUT\n"
    && bashFullOutput.truncated === false
    && bashExpansion?.content.includes("full_output:\nPROBE-BASH-FULL-OUTPUT")
  );
  const malformedToolProtocolOpaque = !byId.has(orphanResultId)
    && !byId.has(duplicateCallId)
    && !byId.has(duplicateResultId)
    && !byId.has(missingCallId)
    && !byId.has(missingCallResultId)
    && opaque.some((segment) =>
      segment.reason === "tool-protocol" && segment.entryIds.includes(orphanResultId))
    && opaque.some((segment) => segment.reason === "tool-protocol"
      && segment.entryIds.includes(duplicateCallId)
      && segment.entryIds.includes(duplicateResultId))
    && opaque.some((segment) => segment.reason === "tool-protocol"
      && segment.entryIds.includes(missingCallId))
    && opaque.some((segment) => segment.reason === "tool-protocol"
      && segment.entryIds.includes(missingCallResultId));
  const toolBatchAtomicity = (() => {
    const segment = opaque.find((candidate) => candidate.entryIds.includes(batchImageId));
    const incomplete = opaque.find((candidate) => candidate.entryIds.includes(incompleteCallId));
    return Boolean(segment)
      && segment.entryIds.includes(batchCallId)
      && segment.entryIds.includes(batchTextId)
      && Boolean(incomplete)
      && !byId.has(batchCallId)
      && !byId.has(batchTextId)
      && !byId.has(batchImageId)
      && !byId.has(incompleteCallId)
      && !stored.includes("PROBE-BATCH-TEXT");
  })();
  const controlBoundaryWithoutSummary = boundaries.length >= 1
    && boundaries.every((boundary) => !JSON.stringify(boundary).includes("PROBE-"))
    && !stored.includes("PROBE-COMPACTION-SUMMARY")
    && !stored.includes("PROBE-BRANCH-SUMMARY");
  const privateContentExcluded = !stored.includes("PROBE-THINKING")
    && !stored.includes("PROBE-PRIVATE-DETAILS")
    && !stored.includes("PROBE-EXTENSION-DATA")
    && !stored.includes("PROBE-EXCLUDED-BASH");

  // 归档格式身份不匹配时丢弃重建，不存在读取其它格式的路径。
  const manifestPath = join(archiveRoot, sha256(identity.sessionId), "session.json");
  writeJson(manifestPath, { format: "superseded-format", ...identity });
  const rebuiltMemory = new FileLongTermMemory(archiveRoot);
  await coordinatorFor(identity, rebuiltMemory).archiveCurrentRoute(routeSnapshot);
  const rebuilt = await rebuiltMemory.listSources(identity);
  const archiveFormatRebuilt = rebuilt.length === records.length
    && JSON.parse(readFileSync(manifestPath, "utf8")).format === "message-source-v1";

  const checks = {
    foreignTextProjected,
    mixedUnitOpaque,
    bashFullOutputRecoverable,
    opaqueLocatorSanitized,
    opaqueLocatorBarrierRejected,
    malformedToolProtocolOpaque,
    toolBatchAtomicity,
    controlBoundaryWithoutSummary,
    privateContentExcluded,
    archiveFormatRebuilt,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    counts: { records: records.length, opaqueSegments: opaque.length, controlBoundaries: boundaries.length },
  };
}

const startedAt = new Date().toISOString();
const baseline = validateProviderBaseline();
const unpersisted = validateUnpersistedSession();
const coordination = await validateStorageAndCoordination();
const boundary = await validateProjectionBoundary();
const checks = { ...baseline.checks, ...unpersisted.checks, ...coordination.checks, ...boundary.checks };
assertImplementationEvidenceUnchanged(root, "source-archive", implementation);
const summary = {
  schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
  generatedBy: "scripts/validate-source-archive.mjs",
  scope,
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  piVersion,
  nodeVersion: process.versions.node,
  implementation,
  passed: baseline.passed && unpersisted.passed && coordination.passed && boundary.passed
    && Object.values(checks).every(Boolean),
  checks,
  providerBaseline: baseline,
  unpersisted,
  coordination,
  projectionBoundary: boundary,
  limitations: [
    "The local scope covers source storage and coordination with a zero-request local Provider probe.",
    "Derived memory, recall quality, Provider lifecycle, and complete API cost use their dedicated validation paths.",
    "The archive covers persisted Pi sessions on the local file system; cross-machine synchronization and retention policy remain future operational responsibilities.",
  ],
};
writeJson(join(artifactRoot, "summary.json"), summary);

if (scope === "local") {
  const stableEvidence = {
    schemaVersion: summary.schemaVersion,
    generatedBy: summary.generatedBy,
    scope: summary.scope,
    runId: summary.runId,
    recordedAt: summary.completedAt,
    piVersion,
    nodeVersion: summary.nodeVersion,
    implementation,
    passed: summary.passed,
    checks,
    profileId: baseline.profileId,
    sourceCounts: coordination.sourceCounts,
    projectionCounts: boundary.counts,
    fullOutput: coordination.fullOutput,
    limitations: summary.limitations,
  };
  if (stableEvidence.passed) replaceJson(evidencePath, stableEvidence);
  console.error(`current evidence: ${evidencePath}`);
}
console.log(JSON.stringify(summary, null, 2));
console.error(`raw evidence: ${artifactRoot}`);
if (!summary.passed) process.exitCode = 1;
