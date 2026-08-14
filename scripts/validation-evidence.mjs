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
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/recall-and-provenance.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
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
      "malformedSearchRejected",
      "noContentWrite",
      "resourceDiagnosticsOptional",
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
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/recall-and-provenance.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      "pyproject.toml",
      "scripts/install-dependencies.mjs",
      "scripts/validate-source-recall.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/check-validation-evidence.mjs",
      "uv.lock",
      "validation/fixtures/openviking-source-recall.json",
    ],
  },
  "context-enhancement": {
    current: true,
    evidencePath: "validation/evidence/context-enhancement.json",
    generatedBy: "scripts/validate-context-enhancement.mjs",
    requiredChecks: [
      "backendFailureFallsBack",
      "backendFailureRecovery",
      "branchIsolation",
      "compactionBoundary",
      "compactionLifecycle",
      "contextBounded",
      "contextHookNonBlocking",
      "currentRouteIdentity",
      "currentTurnPreserved",
      "inFlightShutdownCleaned",
      "lifecycleProviderStateConsistent",
      "invalidRouteRejected",
      "lateRouteResultRejected",
      "linearRouteReused",
      "localProviderOnly",
      "mismatchedRuntimeRejected",
      "openVikingProtocolCovered",
      "ownedSessionsCleaned",
      "pendingRoutesCollapsed",
      "piContextHookAdopted",
      "piProtocolFailClosed",
      "providerPayloadCurrentTurn",
      "providerStateUnspoofable",
      "sessionReplacementLifecycle",
      "sessionIsolation",
      "sharedFixtureLoaded",
      "sourceIdsPreserved",
      "treeLifecycle",
      "workingMemoryAssembled",
      "workingContextResponseNormalized",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      "scripts/check-validation-evidence.mjs",
      "scripts/validate-context-enhancement.mjs",
      "scripts/validation-evidence.mjs",
      "validation/fixtures/context-enhancement-long-task.json",
    ],
  },
  "context-quality": {
    current: true,
    evidencePath: "validation/evidence/context-quality.json",
    generatedBy: "scripts/validate-context-quality.mjs",
    requiredChecks: [
      "enhancedContextAdopted",
      "enhancedQuality",
      "memoryRequestSemanticsObserved",
      "nativeQuality",
      "pairedConditions",
      "realWorkingMemoryReady",
      "sameTaskModel",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      "config/openviking.json",
      "pyproject.toml",
      "scripts/openviking-config.py",
      "scripts/start-openviking.mjs",
      "scripts/check-validation-evidence.mjs",
      "scripts/validate-context-quality.mjs",
      "scripts/validation-evidence.mjs",
      "uv.lock",
      "validation/fixtures/context-enhancement-long-task.json",
    ],
  },
  "memory-model-runtime": {
    current: true,
    evidencePath: "validation/evidence/memory-model-runtime.json",
    generatedBy: "scripts/validate-memory-model-runtime.mjs",
    requiredChecks: [
      "adapterProtocolsCovered",
      "automaticConfigErrorReported",
      "azureFieldRejected",
      "branchUnchanged",
      "childExitPublished",
      "commandNoProviderRequests",
      "commentedTemplateCreated",
      "concurrentLauncherRejected",
      "concurrentRestartSerialized",
      "configCommandReadOnly",
      "configSecretsExcluded",
      "configurationDiagnosticContentHashed",
      "configuredAndRunningDistinct",
      "contextRemainsPiNative",
      "deadChildReadySuppressed",
      "deterministicFingerprint",
      "emptyConfigurationAccepted",
      "emptyConfigurationDisablesModel",
      "existingConfigPreserved",
      "existingSymlinksPreserved",
      "generatedConfigParsed",
      "interruptedControlOperationCompletes",
      "invalidColdStartFallsBack",
      "invalidConfigDiagnosed",
      "jsoncConfigurationParsed",
      "launcherOwnershipProtected",
      "litellmCatalogDocumented",
      "litellmCatalogObserved",
      "missingCredentialRejected",
      "missingLauncherReported",
      "nullConfigurationStateReported",
      "operationDeadlineCoversFailureCleanup",
      "operationDeadlinePublished",
      "orderedRestart",
      "preflightPreservesInstance",
      "providerDefaultsNotOverridden",
      "supportedProviderSurface",
      "readinessTimeoutPublished",
      "schemaObserved",
      "sharedUserConfig",
      "signalCleansOwnedChild",
      "staleLifecycleLockRequiresExplicitRecovery",
      "staleRuntimeSuppressed",
      "targetPortPreflightPreservesInstance",
      "taskModelUnchanged",
      "unrelatedReadyNotReconciled",
      "unknownFieldRejected",
      "upstreamProviderAdditionsTolerated",
      "unknownPortPreserved",
      "userConfigPath",
      "wrongLaunchRejected",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      "config/openviking.json",
      "pyproject.toml",
      "scripts/check-validation-evidence.mjs",
      "scripts/openviking-config.py",
      "scripts/validate-openviking-vlm-adapters.py",
      "scripts/start-openviking.mjs",
      "scripts/validate-memory-model-runtime.mjs",
      "scripts/validation-evidence.mjs",
      "uv.lock",
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
  if (key === "context-enhancement") {
    const lifecycle = evidence?.details?.pi?.lifecycle;
    const requiredLifecycle = [
      "treeRoundTrip",
      "treeSummaryChoices",
      "treeCancellationState",
      "rootNavigation",
      "treeProviderAdoption",
      "replacements",
      "replacementProviderAdoption",
      "reload",
      "compactionReasons",
      "overflowRetryFallsBack",
      "compactionCancellationState",
      "compactionProviderAdoption",
      "backendRecovery",
      "providerStateConsistent",
    ];
    if (!lifecycle || requiredLifecycle.some((name) => lifecycle[name] !== true)) {
      mismatches.push("context lifecycle evidence is incomplete");
    }
    if (!(lifecycle?.eventCounts?.tree >= 6)
      || !(lifecycle?.eventCounts?.compaction >= 3)
      || !(lifecycle?.eventCounts?.starts >= 5)
      || !(lifecycle?.eventCounts?.providerRequests >= 1)) {
      mismatches.push("context lifecycle event counts are incomplete");
    }
  }
  if (key === "context-quality") {
    const native = evidence?.arms?.native;
    const enhanced = evidence?.arms?.enhanced;
    const fixture = JSON.parse(readFileSync(resolve(root, "validation/fixtures/context-enhancement-long-task.json"), "utf8"));
    const qualityOutputValid = (arm) => {
      if (!arm || typeof arm.text !== "string" || sha256(arm.text) !== arm.textSha256) return false;
      try {
        const parsed = JSON.parse(arm.text);
        return parsed?.decision === fixture.task.checker.requiredDecision
          && parsed?.evidence_entry_id === fixture.task.checker.requiredEvidenceEntryId
          && parsed?.decision !== fixture.task.checker.forbiddenDecision;
      } catch {
        return false;
      }
    };
    if (evidence?.execution?.repetitions !== 1
      || JSON.stringify(evidence?.execution?.order) !== JSON.stringify(["native", "enhanced"])) {
      mismatches.push("quality execution conditions are missing");
    }
    if (typeof evidence?.models?.task !== "string" || typeof evidence?.models?.memory !== "string") {
      mismatches.push("quality model evidence is missing");
    }
    if (typeof evidence?.memoryModelCondition?.configFingerprint !== "string"
      || !Array.isArray(evidence?.memoryModelCondition?.explicitRequestControls)
      || evidence.memoryModelCondition.explicitRequestControls.length !== 0
      || typeof evidence?.models?.memory !== "string"
      || !evidence.models.memory.startsWith("openai-codex/")
      || evidence.memoryModelCondition.adapterRequest?.adapter !== "Codex Responses"
      || evidence.memoryModelCondition.adapterRequest?.reasoningForwarded !== false
      || evidence.memoryModelCondition.adapterRequest?.temperatureForwarded !== false
      || evidence.memoryModelCondition.adapterRequest?.stream !== true
      || evidence.memoryModelCondition.reasoningSemantics !== "provider-default") {
      mismatches.push("memory model request-control evidence is missing");
    }
    if (!qualityOutputValid(native) || !qualityOutputValid(enhanced)) {
      mismatches.push("quality arm output is invalid");
    }
    if (native?.model !== evidence?.models?.task
      || enhanced?.model !== evidence?.models?.task
      || !native?.condition
      || native.condition.model !== evidence?.models?.task
      || native.condition.thinking !== "off"
      || JSON.stringify(native.condition.activeTools) !== "[]"
      || typeof native.condition.modelHash !== "string"
      || typeof native.condition.systemPromptHash !== "string"
      || JSON.stringify(native.condition) !== JSON.stringify(enhanced?.condition)) {
      mismatches.push("quality arm conditions differ");
    }
    if (!(enhanced?.observations?.workingContextReady > 0)
      || !(enhanced?.observations?.enhancedProviderRequests > 0)) {
      mismatches.push("enhanced quality adoption evidence is missing");
    }
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
