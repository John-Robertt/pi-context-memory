import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readProjectOpenVikingVersion,
  readValidationModels,
  readValidationSuite,
  VALIDATION_SUITE_PATH,
} from "./validation-suite.mjs";

export const STABLE_EVIDENCE_SCHEMA_VERSION = 2;
const DEFINITIONS = {
  "source-archive": {
    current: true,
    expectedScope: "local",
    evidenceClass: "local-boundary",
    evidencePath: "validation/evidence/source-archive.json",
    generatedBy: "scripts/validate-source-archive.mjs",
    requiredChecks: [
      "archiveFormatRebuilt",
      "assistantPreserved",
      "bashBecomesUser",
      "bashFullOutputRecoverable",
      "branchFiltering",
      "completeFullOutput",
      "controlBoundaryWithoutSummary",
      "corruptedBlobBarrierRejected",
      "corruptedBlobRejected",
      "customBecomesUser",
      "excludedBashDropped",
      "foreignTextProjected",
      "fullOutputCopyTimeoutEnforced",
      "fullOutputPublicationAtomic",
      "invalidRouteRejected",
      "messageSourceReprojection",
      "mixedUnitOpaque",
      "opaqueLocatorBarrierRejected",
      "opaqueLocatorSanitized",
      "malformedToolProtocolOpaque",
      "nonContextEntriesDropped",
      "noProviderRequests",
      "privateContentExcluded",
      "sessionIsolation",
      "storageFailurePropagates",
      "summariesBecomeUser",
      "toolBatchAtomicity",
      "toolResultPreserved",
      "unknownRoleDropped",
      "unpersistedSessionSkipped",
      "userPreserved",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/provider-payload-proof.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/recall-and-provenance.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      "scripts/validate-source-archive.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/validation-suite.mjs",
      "scripts/check-validation-evidence.mjs",
    ],
  },
  "source-recall": {
    current: true,
    expectedScope: "local",
    evidenceClass: "local-integration",
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
      ".pi/extensions/pi-context-memory/provider-payload-proof.ts",
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
      "scripts/validation-suite.mjs",
      "scripts/check-validation-evidence.mjs",
      "uv.lock",
      "config/openviking.json",
    ],
  },
  "context-enhancement": {
    current: true,
    expectedScope: "local",
    evidenceClass: "controlled-protocol",
    evidencePath: "validation/evidence/context-enhancement.json",
    generatedBy: "scripts/validate-context-enhancement.mjs",
    requiredChecks: [
      "activeHistoryAvailableDuringWorkingMemory",
      "backendFailureBlocks",
      "archiveFailureLatchesUntilNewGeneration",
      "backendFailureLatchesUntilNewGeneration",
      "branchIsolation",
      "compactionBoundary",
      "compactionLifecycle",
      "contextBlockStopsExtension",
      "contextBounded",
      "currentRouteIdentity",
      "currentTurnPreserved",
      "desiredConfigDoesNotDisableRuntime",
      "hookOutcomeAccounting",
      "hookTransportStateConsistent",
      "hookVerifiedAtExtension",
      "inFlightCommitShutdownCleaned",
      "inFlightContextWaitAdopted",
      "inFlightReadyWaitBounded",
      "inFlightShutdownCleaned",
      "invalidRouteRejected",
      "lateRouteResultRejected",
      "latestRoutePromotedAfterCommit",
      "linearRouteReused",
      "localProviderOnly",
      "memoryStatusThreeStateLifecycle",
      "openVikingProtocolCovered",
      "opaqueHistoryBlocks",
      "ownedSessionsCleaned",
      "pendingRoutesCollapsed",
      "pendingTokensPreservedAcrossCommit",
      "piProtocolUnknownDropped",
      "providerPayloadCurrentTurn",
      "proofContentMutationRejected",
      "proofMessageSequenceBound",
      "proofToolSequenceBound",
      "routesPrepareDuringWorkingMemory",
      "sessionIsolation",
      "sessionReplacementLifecycle",
      "sharedFixtureLoaded",
      "singleCommitFlightPerMirror",
      "skippedCommitRetainsActiveHistory",
      "slowWorkingMemoryCompletesWithinDeadline",
      "sourceIdsPreserved",
      "spoofedMarkerCannotAuthorize",
      "transportObservedIndependently",
      "treeLifecycle",
      "workingContextResponseNormalized",
      "workingMemoryAssembled",
      "workingMemoryTaskDeadlineBounded",
      "workingMemoryTimeoutRetainsActiveHistory",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/provider-payload-proof.ts",
      ".pi/extensions/pi-context-memory/long-term-memory.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      "scripts/check-validation-evidence.mjs",
      "scripts/install-dependencies.mjs",
      "scripts/validate-context-enhancement.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/validation-suite.mjs",
      "validation/fixtures/context-enhancement-long-task.json",
    ],
  },
  "context-quality": {
    current: true,
    expectedScope: "real-provider-quality",
    evidenceClass: "paired-diagnostic",
    evidencePath: "validation/evidence/context-quality.json",
    generatedBy: "scripts/validate-context-quality.mjs",
    requiredChecks: [
      "credentialIsolated",
      "enhancedContextHookVerified",
      "enhancedQuality",
      "memoryRequestSemanticsObserved",
      "memoryUsageAttributed",
      "nativeQuality",
      "pairedConditions",
      "realWorkingMemoryReady",
      "sameTaskModel",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/provider-payload-proof.ts",
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
      "scripts/install-dependencies.mjs",
      "scripts/validate-context-quality.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/validation-suite.mjs",
      "uv.lock",
      "validation/fixtures/context-enhancement-long-task.json",
    ],
  },
  "memory-model-runtime": {
    current: true,
    expectedScope: "local",
    evidenceClass: "controlled-runtime",
    evidencePath: "validation/evidence/memory-model-runtime.json",
    generatedBy: "scripts/validate-memory-model-runtime.mjs",
    requiredChecks: [
      "adapterProtocolsCovered",
      "apiKeyFormsPreserved",
      "apiKeysBoundToSettings",
      "automaticConfigErrorReported",
      "azureFieldRejected",
      "branchUnchanged",
      "childExitPublished",
      "codexNativeCredentialPreserved",
      "commandNoProviderRequests",
      "commentedTemplateCreated",
      "concurrentLauncherRejected",
      "concurrentRestartSerialized",
      "configCommandReadOnly",
      "configurationDiagnosticContentHashed",
      "credentialDiagnosticsRedacted",
      "configuredAndRunningReportedSeparately",
      "deadChildReadySuppressed",
      "deterministicFingerprint",
      "environmentReferencesExpanded",
      "invalidDesiredConfigPreservesRunningInstance",
      "emptyConfigurationAccepted",
      "emptyConfigurationDisablesModel",
      "existingConfigPreserved",
      "existingSymlinksPreserved",
      "generatedConfigParsed",
      "interruptedControlOperationCompletes",
      "invalidColdStartKeepsSourceRuntime",
      "invalidConfigDiagnosed",
      "jsoncConfigurationParsed",
      "launcherLogsExcludeCredentials",
      "launcherOwnershipProtected",
      "litellmCatalogDocumented",
      "litellmCatalogObserved",
      "memoryStatusVocabularyCurrent",
      "missingCredentialRejected",
      "missingReferencedCredentialRejected",
      "missingLauncherReported",
      "nullConfigurationStateReported",
      "openRouterApiKeyRequired",
      "openRouterLauncherCredentialRequired",
      "operationDeadlineCoversFailureCleanup",
      "operationDeadlinePublished",
      "orderedRestart",
      "piCredentialInjectedIntoIsolatedEnvironment",
      "piSessionCredentialsExcluded",
      "preflightPreservesInstance",
      "providerDefaultsNotOverridden",
      "reviewedConfigurationAdapterSurface",
      "readinessTimeoutPublished",
      "runtimeCredentialsProtected",
      "schemaObserved",
      "sharedUserConfig",
      "splitCredentialRuntimeAvailable",
      "signalCleansOwnedChild",
      "staleLifecycleLockRequiresExplicitRecovery",
      "staleRuntimeSuppressed",
      "targetPortPreflightPreservesInstance",
      "taskModelUnchanged",
      "unrelatedReadyNotReconciled",
      "unknownFieldRejected",
      "unreviewedProviderRejected",
      "unknownPortPreserved",
      "userConfigPath",
      "wrongLaunchRejected",
    ],
    files: [
      ".pi/extensions/pi-context-memory/index.ts",
      ".pi/extensions/pi-context-memory/openviking-protocol.ts",
      ".pi/extensions/pi-context-memory/pi-session-protocol.ts",
      ".pi/extensions/pi-context-memory/provider-payload-proof.ts",
      ".pi/extensions/pi-context-memory/session-memory-coordination.ts",
      ".pi/extensions/pi-context-memory/session-working-memory.ts",
      ".pi/extensions/pi-context-memory/working-context-optimization.ts",
      ".pi/extensions/pi-context-memory/memory-model-configuration.ts",
      "config/openviking.json",
      "pyproject.toml",
      "scripts/check-validation-evidence.mjs",
      "scripts/install-dependencies.mjs",
      "scripts/openviking-config.py",
      "scripts/validate-openviking-vlm-adapters.py",
      "scripts/start-openviking.mjs",
      "scripts/validate-memory-model-runtime.mjs",
      "scripts/validation-evidence.mjs",
      "scripts/validation-suite.mjs",
      "uv.lock",
    ],
  },
};

const COMMON_IMPLEMENTATION_FILES = [
  "config/openviking-adapter-contract.json",
  "config/openviking.json",
  "scripts/check-maintenance-sources.mjs",
];
const COMMON_SPECIFICATION_FILES = [
  "config/toolchain.json",
  "docs/validation/README.md",
  VALIDATION_SUITE_PATH,
];
const SPECIFICATION_FILES = {
  "source-archive": [...COMMON_SPECIFICATION_FILES, "docs/validation/source-archive.md"],
  "source-recall": [
    ...COMMON_SPECIFICATION_FILES,
    ".python-version",
    "docs/validation/source-recall.md",
  ],
  "context-enhancement": [
    ...COMMON_SPECIFICATION_FILES,
    "docs/validation/context-enhancement-state.md",
    "pyproject.toml",
  ],
  "context-quality": [
    ...COMMON_SPECIFICATION_FILES,
    ".python-version",
    "docs/validation/context-enhancement-state.md",
  ],
  "memory-model-runtime": [
    ...COMMON_SPECIFICATION_FILES,
    ".python-version",
    "docs/validation/memory-model-runtime.md",
  ],
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function stableJsonSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function versionAtLeast(actual, minimum) {
  const parse = (value) => {
    if (typeof value !== "string") return undefined;
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
    return match ? match.slice(1).map(Number) : undefined;
  };
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
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
    files: [...new Set([...definition.files, ...COMMON_IMPLEMENTATION_FILES])].sort(),
    specificationFiles: [...SPECIFICATION_FILES[key]].sort(),
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
  const specificationFiles = definition.specificationFiles.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
  return {
    sourceManifestSha256: sha256(JSON.stringify(files)),
    files,
    specificationManifestSha256: sha256(JSON.stringify(specificationFiles)),
    specificationFiles,
    gitCommit: gitOutput(root, ["rev-parse", "HEAD"]),
    workingTreeDirty: gitOutput(root, ["status", "--porcelain=v1"]).length > 0,
  };
}

function fileManifestMismatches(root, label, expectedPaths, recordedFiles, recordedManifestSha256) {
  if (!Array.isArray(recordedFiles) || typeof recordedManifestSha256 !== "string") {
    return [`${label} evidence is missing`];
  }
  const mismatches = [];
  const actualPaths = [];
  const actualByPath = new Map();
  for (const file of recordedFiles) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
      mismatches.push(`${label} evidence contains an invalid file record`);
      continue;
    }
    actualPaths.push(file.path);
    if (actualByPath.has(file.path)) mismatches.push(`${label} evidence repeats ${file.path}`);
    actualByPath.set(file.path, file.sha256);
  }
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    mismatches.push(`${label} file set differs from the validation definition`);
  }
  const currentFiles = [];
  for (const path of expectedPaths) {
    try {
      const currentSha256 = sha256(readFileSync(resolve(root, path)));
      currentFiles.push({ path, sha256: currentSha256 });
      if (actualByPath.get(path) !== currentSha256) mismatches.push(`${path} changed`);
    } catch (error) {
      mismatches.push(`${path} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (currentFiles.length === expectedPaths.length
    && sha256(JSON.stringify(currentFiles)) !== recordedManifestSha256) {
    mismatches.push(`${label} manifest hash differs`);
  }
  return mismatches;
}

export function implementationEvidenceMismatches(root, key, evidence) {
  const definition = validationEvidenceDefinition(key);
  const mismatches = [
    ...fileManifestMismatches(
      root,
      "implementation",
      definition.files,
      evidence?.files,
      evidence?.sourceManifestSha256,
    ),
    ...fileManifestMismatches(
      root,
      "validation specification",
      definition.specificationFiles,
      evidence?.specificationFiles,
      evidence?.specificationManifestSha256,
    ),
  ];
  if (typeof evidence?.gitCommit !== "string" || typeof evidence?.workingTreeDirty !== "boolean") {
    mismatches.push("implementation Git state is missing");
  }
  return [...new Set(mismatches)];
}



export function stableEvidenceMismatches(root, key, evidence) {
  const definition = validationEvidenceDefinition(key);
  const mismatches = [];
  const suite = readValidationSuite(root);
  const expectedOpenVikingVersion = key === "source-archive"
    ? undefined
    : readProjectOpenVikingVersion(root);
  if (evidence?.piVersion !== suite.host.pi.version) {
    mismatches.push("stable evidence Pi coordinate differs from validation/suite.json");
  }
  const toolchain = JSON.parse(readFileSync(resolve(root, "config/toolchain.json"), "utf8"));
  if (!versionAtLeast(evidence?.nodeVersion, toolchain.node?.minimum)) {
    mismatches.push("stable evidence Node.js coordinate is below the toolchain minimum or invalid");
  }
  if (key === "context-enhancement") {
    if (evidence?.piProtocolProfile !== suite.host.pi.protocolProfile
      || evidence?.openViking?.kind !== "controlled-protocol"
      || evidence?.openViking?.compatibilityTarget !== expectedOpenVikingVersion) {
      mismatches.push("controlled protocol coordinates differ from the validation suite and dependency lock");
    }
  } else if (["source-recall", "context-quality", "memory-model-runtime"].includes(key)
    && evidence?.openVikingVersion !== expectedOpenVikingVersion) {
    mismatches.push("stable evidence OpenViking coordinate differs from pyproject.toml");
  }
  if (key === "memory-model-runtime") {
    const adapterContract = JSON.parse(readFileSync(resolve(root, "config/openviking-adapter-contract.json"), "utf8"));
    if (evidence?.vlmSchemaSha256 !== adapterContract.vlmSchemaSha256
      || evidence?.adapterContractSha256 !== stableJsonSha256(adapterContract)) {
      mismatches.push("memory adapter contract evidence differs from the current reviewed contract");
    }
  }
  if (evidence?.schemaVersion !== STABLE_EVIDENCE_SCHEMA_VERSION) mismatches.push("stable evidence schema is unsupported");
  if (evidence?.generatedBy !== definition.generatedBy) mismatches.push("stable evidence generator differs");
  if (evidence?.scope !== definition.expectedScope) mismatches.push("stable evidence scope differs");
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
      "overflowRetryAuthorized",
      "compactionCancellationState",
      "compactionProviderAdoption",
      "backendRecovery",
      "providerStateConsistent",
      "memoryStatusLifecycle",
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
    const suite = readValidationSuite(root);
    const models = readValidationModels(root);
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
    if (evidence?.execution?.repetitions !== suite.diagnostics.pairedQualityRepetitions
      || JSON.stringify(evidence?.execution?.order) !== JSON.stringify(["native", "enhanced"])) {
      mismatches.push("quality execution conditions are missing");
    }
    if (evidence?.models?.task !== models.task
      || evidence?.models?.memory !== models.memory) {
      mismatches.push("quality models differ from validation/suite.json");
    }
    if (typeof evidence?.memoryModelCondition?.configFingerprint !== "string"
      || !Array.isArray(evidence?.memoryModelCondition?.explicitRequestControls)
      || evidence.memoryModelCondition.explicitRequestControls.length !== 0
      || evidence.models?.memory !== models.memory
      || evidence.memoryModelCondition.adapterRequest?.adapter !== "LiteLLM OpenRouter"
      || evidence.memoryModelCondition.adapterRequest?.model !== models.task
      || evidence.memoryModelCondition.adapterRequest?.apiKeyForwarded !== true
      || evidence.memoryModelCondition.adapterRequest?.reasoningForwarded !== false
      || evidence.memoryModelCondition.adapterRequest?.temperatureForwarded !== true
      || evidence.memoryModelCondition.adapterRequest?.temperature !== 0
      || evidence.memoryModelCondition.adapterRequest?.timeoutForwarded !== true
      || evidence.memoryModelCondition.reasoningSemantics !== "provider-default") {
      mismatches.push("memory model request-control evidence is missing");
    }
    const tokenRows = evidence?.openVikingUsage?.tokenRows;
    const memoryTokenRows = Array.isArray(tokenRows)
      ? tokenRows.filter((row) => row?.source === "vlm"
        && row.provider === suite.models.memoryProvider
        && row.model_name === suite.models.memoryRoute)
      : [];
    const memoryTotalTokens = memoryTokenRows.reduce((total, row) => total + (Number.isSafeInteger(row.token_count) ? row.token_count : 0), 0);
    if (memoryTokenRows.length !== 2
      || !memoryTokenRows.some((row) => row.token_type === "input" && row.token_count > 0)
      || !memoryTokenRows.some((row) => row.token_type === "output" && row.token_count > 0)
      || evidence?.openVikingUsage?.memoryTotalTokens !== memoryTotalTokens) {
      mismatches.push("OpenRouter memory token attribution is missing");
    }
    if (!qualityOutputValid(native) || !qualityOutputValid(enhanced)) {
      mismatches.push("quality arm output is invalid");
    }
    if (native?.model !== evidence?.models?.task
      || enhanced?.model !== evidence?.models?.task
      || !native?.condition
      || native.condition.model !== evidence?.models?.task
      || native.condition.thinking !== suite.models.taskThinking
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
