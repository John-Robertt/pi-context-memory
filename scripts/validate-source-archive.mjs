#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

import { FileLongTermMemory } from "../.pi/extensions/pi-context-memory/long-term-memory.ts";
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

const { SessionManager } = await import(pathToFileURL(join(locatePiDist(), "index.js")).href);

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
  const firstCoordinator = new SessionMemoryCoordinator(firstIdentity, memory);
  const secondCoordinator = new SessionMemoryCoordinator(secondIdentity, memory);
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
    historical.some((record) => record.entry.id === routeAId)
    && historical.some((record) => record.entry.id === routeBId)
    && !current.some((record) => record.entry.id === routeAId)
    && current.some((record) => record.entry.id === routeBId)
    && await firstCoordinator.resolveCurrentSource(routeBSnapshot, routeAId) === undefined
  );

  const restored = await Promise.all(routeBSnapshot.entries.map((entry) =>
    firstCoordinator.resolveCurrentSource(routeBSnapshot, entry.id),
  ));
  const sourceRestoration = restored.every((item, index) => (
    item
    && item.record.source.sessionId === firstIdentity.sessionId
    && item.record.source.sessionFile === firstIdentity.sessionFile
    && item.record.source.entryId === routeBSnapshot.entries[index].id
    && JSON.stringify(item.authoritativeEntry) === JSON.stringify(first.getEntry(item.record.source.entryId))
  ));

  const toolCallId = "call_source_archive_validation";
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
  const recoveryCoordinator = new SessionMemoryCoordinator(firstIdentity, memory);
  const archivedLarge = await recoveryCoordinator.archiveCurrentRoute(largeSnapshot);
  const opened = await memory.openLargeResult(firstIdentity, toolResultId);
  const copied = opened ? await consume(opened.stream) : Buffer.alloc(0);
  const completeLargeResult = (
    recoveryCoordinator !== firstCoordinator
    && archivedLarge.archivedToolCallIds.length === 1
    && archivedLarge.archivedToolCallIds[0] === toolCallId
    && opened?.record.bytes === largeOutput.length
    && opened?.record.sha256 === sha256(largeOutput)
    && copied.equals(largeOutput)
  );

  const blobPath = join(
    archiveRoot,
    sha256(firstIdentity.sessionId),
    "large-results",
    "blobs",
    opened.record.blob,
  );
  const originalBlob = readFileSync(blobPath);
  writeFileSync(blobPath, Buffer.concat([originalBlob, Buffer.from("corrupt")]));
  const corruptedBlobRejected = await expectFailure(() => memory.openLargeResult(firstIdentity, toolResultId));
  writeFileSync(blobPath, originalBlob);

  const recordsPath = join(archiveRoot, sha256(firstIdentity.sessionId), "large-results", "records");
  const recordsBackup = `${recordsPath}.validation-backup`;
  renameSync(recordsPath, recordsBackup);
  writeFileSync(recordsPath, "blocked");
  let metadataPublishFailurePreservesPublishedResult;
  try {
    metadataPublishFailurePreservesPublishedResult = await expectFailure(() =>
      memory.archiveLargeResult(firstIdentity, first.getEntry(toolResultId), toolCallId, largeOutputPath),
    );
  } finally {
    rmSync(recordsPath, { force: true });
    renameSync(recordsBackup, recordsPath);
  }
  const reopened = await memory.openLargeResult(firstIdentity, toolResultId);
  const reopenedContent = reopened ? await consume(reopened.stream) : Buffer.alloc(0);
  const largeResultPublicationAtomic = (
    metadataPublishFailurePreservesPublishedResult
    && reopened?.record.sha256 === sha256(largeOutput)
    && reopenedContent.equals(largeOutput)
  );

  const timeoutSource = join(caseDir, "timeout-source.bin");
  writeFileSync(timeoutSource, "");
  truncateSync(timeoutSource, 64 * 1024 * 1024);
  const timeoutMemory = new FileLongTermMemory(join(caseDir, "timeout-archive"), 1);
  const timeoutCoordinator = new SessionMemoryCoordinator(firstIdentity, timeoutMemory);
  await timeoutCoordinator.archiveCurrentRoute(largeSnapshot);
  const largeResultCopyTimeoutEnforced = await expectFailure(() =>
    timeoutMemory.archiveLargeResult(firstIdentity, first.getEntry(toolResultId), toolCallId, timeoutSource),
  );
  rmSync(timeoutSource, { force: true });

  const broken = {
    ...largeSnapshot,
    entries: largeSnapshot.entries.map((entry, index) => index === 1 ? { ...entry, parentId: "not-current-parent" } : entry),
  };
  const invalidRouteRejected = await expectFailure(() => firstCoordinator.archiveCurrentRoute(broken));

  const blockedRoot = join(caseDir, "blocked-root");
  writeFileSync(blockedRoot, "not a directory", "utf8");
  const blockedCoordinator = new SessionMemoryCoordinator(firstIdentity, new FileLongTermMemory(blockedRoot));
  const storageFailurePropagates = await expectFailure(() => blockedCoordinator.archiveCurrentRoute(largeSnapshot));

  return {
    passed: [
      sessionIsolation,
      branchFiltering,
      sourceRestoration,
      completeLargeResult,
      corruptedBlobRejected,
      largeResultPublicationAtomic,
      largeResultCopyTimeoutEnforced,
      invalidRouteRejected,
      storageFailurePropagates,
    ].every(Boolean),
    checks: {
      sessionIsolation,
      branchFiltering,
      sourceRestoration,
      completeLargeResult,
      corruptedBlobRejected,
      largeResultPublicationAtomic,
      largeResultCopyTimeoutEnforced,
      invalidRouteRejected,
      storageFailurePropagates,
    },
    sourceCounts: {
      firstSessionHistorical: historical.length,
      firstSessionCurrentBranch: current.length,
      secondSessionCurrentBranch: secondSources.length,
    },
    largeResult: { bytes: largeOutput.length, sha256: sha256(largeOutput) },
  };
}


const startedAt = new Date().toISOString();
const unpersisted = validateUnpersistedSession();
const coordination = await validateStorageAndCoordination();
const checks = { ...unpersisted.checks, ...coordination.checks };
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
  passed: unpersisted.passed && coordination.passed && Object.values(checks).every(Boolean),
  checks,
  unpersisted,
  coordination,
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
    sourceCounts: coordination.sourceCounts,
    largeResult: coordination.largeResult,
    limitations: summary.limitations,
  };
  if (stableEvidence.passed) replaceJson(evidencePath, stableEvidence);
  console.error(`current evidence: ${evidencePath}`);
}
console.log(JSON.stringify(summary, null, 2));
console.error(`raw evidence: ${artifactRoot}`);
if (!summary.passed) process.exitCode = 1;
