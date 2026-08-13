import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFINITIONS = {
  "source-archive": {
    current: true,
    evidencePath: "validation/evidence/source-archive.json",
    generatedBy: "scripts/validate-source-archive.mjs",
    requiredChecks: [
      "branchFiltering",
      "completeLargeResult",
      "corruptedBlobRejected",
      "invalidRouteRejected",
      "largeResultCopyTimeoutEnforced",
      "largeResultPublicationAtomic",
      "noProviderRequests",
      "sessionIsolation",
      "sourceRestoration",
      "storageFailurePropagates",
      "unpersistedSessionSkipped",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/recall-and-provenance.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      "scripts/validate-source-archive.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/check-validation-evidence.mjs",
    ],
  },
  "source-recall": {
    current: true,
    evidencePath: "validation/evidence/source-recall.json",
    generatedBy: "scripts/validate-source-recall.mjs",
    requiredChecks: [
      "abortedSynchronizationStopsTraversal",
      "authorityMismatchRejected",
      "backendFailureDistinct",
      "backgroundBacklogCollapsed",
      "branchFiltering",
      "cancelledPendingRemoved",
      "concurrentMismatchRejected",
      "concurrentRebuildConverged",
      "deletedIndexRestored",
      "emptyResultDistinct",
      "expansionBounded",
      "idempotentResources",
      "immutableMismatchRejected",
      "insecureRemoteRejected",
      "localEmbeddingConfigured",
      "noContentWrite",
      "noSemanticProcessing",
      "noSourcesShortCircuit",
      "oldSourceRejected",
      "pendingRequiredShared",
      "postStartInvocationQueued",
      "requiredPrioritizedOverBackground",
      "requiredStartedAfterBackground",
      "returnToRunningRouteDropsStaleBackground",
      "searchBounded",
      "shutdownRejectedWaiter",
      "sessionIsolation",
      "sourceRestoration",
      "stableNoSplitResources",
      "staleBranchCandidatesExcludedBeforeRanking",
      "timedOutSynchronizationCancelled",
      "synchronousFailureRejected",
      "waitsForCompleteRound",
      "vectorsOnly",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/recall-and-provenance.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      "pyproject.toml",
      "scripts/install-dependencies.mjs",
      "scripts/validate-source-recall.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/check-validation-evidence.mjs",
      "uv.lock",
      "validation/fixtures/openviking-source-recall.json",
    ],
  },
};


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitOutput(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function validationEvidenceDefinition(key) {
  const definition = DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown validation evidence: ${key}`);
  return {
    ...definition,
    files: [...definition.files].sort(),
    requiredChecks: [...definition.requiredChecks].sort(),
  };
}

export function currentValidationEvidenceKeys() {
  return Object.entries(DEFINITIONS)
    .filter(([, definition]) => definition.current)
    .map(([key]) => key)
    .sort();
}

export function captureImplementationEvidence(root, key) {
  const definition = validationEvidenceDefinition(key);
  const files = definition.files.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
  return {
    sourceManifestSha256: sha256(JSON.stringify(files)),
    files,
    gitCommit: gitOutput(root, ["rev-parse", "HEAD"]),
    workingTreeDirty: gitOutput(root, ["status", "--porcelain=v1"]).length > 0,
  };
}

export function implementationEvidenceMismatches(root, key, evidence) {
  const definition = validationEvidenceDefinition(key);
  if (!evidence || !Array.isArray(evidence.files) || typeof evidence.sourceManifestSha256 !== "string") {
    return ["implementation evidence is missing"];
  }
  const mismatches = [];
  const actualPaths = [];
  const actualByPath = new Map();
  for (const file of evidence.files) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
      mismatches.push("implementation evidence contains an invalid file record");
      continue;
    }
    actualPaths.push(file.path);
    if (actualByPath.has(file.path)) mismatches.push(`implementation evidence repeats ${file.path}`);
    actualByPath.set(file.path, file.sha256);
  }
  if (JSON.stringify(actualPaths) !== JSON.stringify(definition.files)) {
    mismatches.push("implementation file set differs from the validation definition");
  }
  const currentFiles = [];
  for (const path of definition.files) {
    try {
      const currentSha256 = sha256(readFileSync(resolve(root, path)));
      currentFiles.push({ path, sha256: currentSha256 });
      if (actualByPath.get(path) !== currentSha256) mismatches.push(`${path} changed`);
    } catch (error) {
      mismatches.push(`${path} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (currentFiles.length === definition.files.length && sha256(JSON.stringify(currentFiles)) !== evidence.sourceManifestSha256) {
    mismatches.push("source manifest hash differs");
  }
  if (typeof evidence.gitCommit !== "string" || typeof evidence.workingTreeDirty !== "boolean") {
    mismatches.push("implementation Git state is missing");
  }
  return [...new Set(mismatches)];
}



export function stableEvidenceMismatches(root, key, evidence) {
  const definition = validationEvidenceDefinition(key);
  const mismatches = [];
  if (evidence?.schemaVersion !== 1) mismatches.push("stable evidence schema is unsupported");
  if (evidence?.generatedBy !== definition.generatedBy) mismatches.push("stable evidence generator differs");
  if (evidence?.passed !== true) mismatches.push("stable evidence is not passing");
  const checks = evidence?.checks && typeof evidence.checks === "object" && !Array.isArray(evidence.checks)
    ? evidence.checks
    : undefined;
  const checkNames = checks ? Object.keys(checks).sort() : [];
  if (JSON.stringify(checkNames) !== JSON.stringify(definition.requiredChecks)) {
    mismatches.push("stable evidence check set differs from the validation definition");
  }
  for (const check of definition.requiredChecks) {
    if (checks?.[check] !== true) mismatches.push(`stable evidence check ${check} is not passing`);
  }
  if (key === "source-recall") {
    const config = evidence?.openVikingConfig;
    if (!config?.effective || typeof config.effectiveSha256 !== "string") {
      mismatches.push("effective OpenViking configuration evidence is missing");
    } else if (sha256(JSON.stringify(config.effective)) !== config.effectiveSha256) {
      mismatches.push("effective OpenViking configuration hash differs");
    }
  }
  mismatches.push(...implementationEvidenceMismatches(root, key, evidence?.implementation));
  return [...new Set(mismatches)];
}

export function assertImplementationEvidenceUnchanged(root, key, evidence) {
  const mismatches = implementationEvidenceMismatches(root, key, evidence);
  if (mismatches.length > 0) {
    throw new Error(`Validation inputs changed during the run (${mismatches.join("; ")})`);
  }
}
