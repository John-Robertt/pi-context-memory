import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContextEntries,
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  DEFAULT_ARCHIVE_COPY_TIMEOUT_MS,
  FileLongTermMemory,
  type SessionIdentity,
} from "./long-term-memory.ts";
import {
  expandSource,
  formatSearchResult,
  OpenVikingSourceRecall,
  RECALL_LIMITS,
} from "./recall-and-provenance.ts";
import {
  SessionMemoryCoordinator,
  SessionSourceIndexCoordinator,
  type SessionRouteIdentity,
  type SessionRouteSnapshot,
} from "./session-memory-coordination.ts";
import {
  type AssemblyProof,
  type ContextAuthorization,
  assemblyRouteProofError,
  type ContextFault,
  createProviderPayloadProfile,
  createRetentionBudgetIdentity,
  payloadCarriesEnhancedContent,
  type ProviderPayloadProfile,
  WorkingContextOptimizer,
} from "./working-context-optimization.ts";
import { OpenVikingSessionMemory } from "./session-working-memory.ts";
import {
  configuredOpenVikingBaseUrl,
  memoryModelConfigPath,
  locateProjectRoot,
  memoryModelSettingsFingerprint,
  memoryModelConfigContentFingerprint,
  validateMemoryModelSetting,
  readRuntimeState,
  runtimePaths,
  requestOpenVikingRestart,
  type MemoryModelSetting,
  type OpenVikingRuntimeState,
} from "./memory-model-configuration.ts";
import { DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS } from "./openviking-protocol.ts";
import { memoryRuntimeGenerationFromState } from "./memory-runtime-capability.ts";
import {
  createOpenAICompletionsPayloadProof,
  openAICompletionsPayloadMatches,
  openAICompletionsPayloadMatchesProfile,
  type ProviderPayloadProof,
} from "./provider-payload-proof.ts";
import {
  entriesBeforeCurrentPrompt,
  currentTurnToolSources,
  isMessageSource,
  isOpaqueProviderSegment,
  sanitizeFullOutputLocators,
  type PiProtocolProfile,
  type SourceEntry,
} from "./pi-session-protocol.ts";
import { installEnhancedFooter } from "./pi-footer-adapter.ts";

/** 当前 suite 所选 PiProtocolProfile；行为由 scripts/validate-source-archive.mjs 的探针固定。 */
const PI_PROTOCOL_PROFILE: PiProtocolProfile = {
  id: "pi-provider-protocol-v1",
  contextEntries: (entries, leafId) => buildContextEntries([...entries] as never[], leafId) as SourceEntry[],
  providerMessages: (entry) => convertToLlm(sessionEntryToContextMessages(entry as never)) as never[],
};

interface PendingRequestProof {
  assembly: AssemblyProof;
  payload: ProviderPayloadProof;
  memoryCapabilityProofId: string;
}

interface LatchedGenerationFault {
  generation: string | undefined;
  stage: "working-context" | "archive" | "source-index" | "provider-proof";
  sessionKey?: string;
  fault: ContextFault;
}

const SCHEMA_VERSION = 1;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const observationPath = process.env.PCR_OBSERVATION_LOG
  ? resolve(process.cwd(), process.env.PCR_OBSERVATION_LOG)
  : undefined;
const runId = process.env.PCR_RUN_ID ?? "manual";
const failureEvent = process.env.PCR_PROBE_FAIL_EVENT;
const archiveDelayMs = Number.parseInt(process.env.PCR_ARCHIVE_DELAY_MS ?? "0", 10) || 0;
const archiveCopyTimeoutMs = (() => {
  const configured = process.env.PCR_ARCHIVE_COPY_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_ARCHIVE_COPY_TIMEOUT_MS;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PCR_ARCHIVE_COPY_TIMEOUT_MS must be a positive integer");
  }
  return value;
})();
const checkpointCommitPendingTokens = (() => {
  const configured = process.env.PCR_CHECKPOINT_COMMIT_PENDING_TOKENS;
  if (configured === undefined) return undefined;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PCR_CHECKPOINT_COMMIT_PENDING_TOKENS must be a positive integer");
  }
  return value;
})();
const openVikingApiKey = process.env.PCR_OPENVIKING_API_KEY;
const openVikingTimeoutMs = (() => {
  const configured = process.env.PCR_OPENVIKING_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PCR_OPENVIKING_TIMEOUT_MS must be a positive integer");
  }
  return value;
})();
const recallParameters = Type.Object({
  action: StringEnum(["search", "read_source"] as const, {
    description: "search for current-session sources or expand one current-branch source",
  }),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: RECALL_LIMITS.queryChars })),
  entry_id: Type.Optional(Type.String({ minLength: 1, maxLength: RECALL_LIMITS.entryIdChars })),
  limit: Type.Optional(Type.Integer({ minimum: RECALL_LIMITS.resultMin, maximum: RECALL_LIMITS.resultMax })),
  max_chars: Type.Optional(Type.Integer({
    minimum: RECALL_LIMITS.expansionMinChars,
    maximum: RECALL_LIMITS.expansionMaxChars,
  })),
}, { additionalProperties: false });
let sequence = 0;
let failureInjected = false;
let providerRequestIndex = 0;

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(serialize(value)).digest("hex");
}

function bytes(value: unknown): number {
  return Buffer.byteLength(serialize(value), "utf8");
}

function writeRecord(type: string, data: Record<string, unknown> = {}): void {
  if (!observationPath) return;
  mkdirSync(dirname(observationPath), { recursive: true });
  appendFileSync(
    observationPath,
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId, sequence: ++sequence, at: new Date().toISOString(), type, ...data })}\n`,
    "utf8",
  );
}

function maybeFail(type: string): void {
  if (failureInjected || failureEvent !== type) return;
  failureInjected = true;
  writeRecord("failure_injected", { event: type });
  throw new Error(`pi-context-memory probe injected failure at ${type}`);
}

function branchSnapshot(ctx: ExtensionContext): Record<string, unknown> {
  const branch = ctx.sessionManager.getBranch();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
    branch: branch.map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      entryType: entry.type,
      messageRole: entry.type === "message" ? entry.message.role : undefined,
    })),
  };
}

function sessionIdentity(ctx: ExtensionContext): SessionIdentity | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: resolve(ctx.cwd, sessionFile) };
}

export function sessionRouteSnapshot(ctx: ExtensionContext): SessionRouteSnapshot | undefined {
  const identity = sessionIdentity(ctx);
  if (!identity) return undefined;
  return {
    ...identity,
    leafId: ctx.sessionManager.getLeafId(),
    entries: ctx.sessionManager.getBranch() as SourceEntry[],
  };
}

function snapshotBeforeCurrentPrompt(snapshot: SessionRouteSnapshot): SessionRouteSnapshot {
  const entries = entriesBeforeCurrentPrompt(snapshot.entries);
  return entries === snapshot.entries
    ? snapshot
    : { ...snapshot, entries, leafId: entries.at(-1)?.id ?? null };
}

function archiveRoot(ctx: ExtensionContext): string {
  const configured = process.env.PCR_ARCHIVE_DIR;
  return configured
    ? resolve(ctx.cwd, configured)
    : join(ctx.sessionManager.getSessionDir(), ".pi-context-memory");
}


async function hasAuthoritativeSessionFile(snapshot: SessionRouteSnapshot): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(snapshot.sessionFile, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < 64 * 1024) {
      const chunk = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
      if (chunk.subarray(0, bytesRead).includes(0x0a)) break;
    }
    const firstLine = Buffer.concat(chunks).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return false;
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    if (header.type !== "session" || header.id !== snapshot.sessionId) {
      throw new Error(`Pi session file identity mismatch for ${snapshot.sessionId}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

function contentSummary(content: unknown): Record<string, unknown> {
  if (typeof content === "string") return { kind: "string", bytes: Buffer.byteLength(content, "utf8") };
  if (!Array.isArray(content)) return { kind: typeof content, bytes: bytes(content) };
  return {
    kind: "blocks",
    blocks: content.length,
    blockTypes: content.map((block) =>
      block && typeof block === "object" && "type" in block ? String(block.type) : typeof block,
    ),
    bytes: bytes(content),
  };
}

function messageSummary(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return { kind: typeof message };
  const value = message as Record<string, unknown>;
  return {
    role: value.role,
    provider: value.provider,
    model: value.model,
    stopReason: value.stopReason,
    responseId: value.responseId,
    content: contentSummary(value.content),
    usage: value.usage,
  };
}

function payloadSummary(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { payloadType: typeof payload, payloadBytes: bytes(payload), payloadHash: hash(payload) };
  }
  const value = payload as Record<string, unknown>;
  const instructions = value.instructions ?? value.system ?? value.system_instruction;
  const messages = value.input ?? value.messages ?? value.contents;
  const tools = value.tools ?? value.toolConfig;
  return {
    payloadKeys: Object.keys(value).sort(),
    payloadBytes: bytes(payload),
    payloadHash: hash(payload),
    instructionsBytes: bytes(instructions ?? ""),
    instructionsHash: hash(instructions ?? ""),
    messagesBytes: bytes(messages ?? []),
    messagesHash: hash(messages ?? []),
    toolsBytes: bytes(tools ?? []),
    toolsHash: hash(tools ?? []),
  };
}
function payloadCarriesNonce(value: unknown, nonce: string, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return value.includes(nonce);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => payloadCarriesNonce(item, nonce, seen));
  return Object.values(value as Record<string, unknown>).some((item) => payloadCarriesNonce(item, nonce, seen));
}


function payloadUsesEnhancedContext(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes("# Enhanced session context");
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => payloadUsesEnhancedContext(item, seen));
  return Object.values(value as Record<string, unknown>).some((item) => payloadUsesEnhancedContext(item, seen));
}

type MemoryUiState = "initializing" | "active" | "faulted";

const MEMORY_UI_TEXT: Record<MemoryUiState, string> = {
  initializing: "增强记忆 · 初始化中",
  active: "增强记忆",
  faulted: "增强记忆 · 故障",
};

function formatMemoryModelState(
  configPath: string,
  setting: MemoryModelSetting | undefined,
  state: OpenVikingRuntimeState | undefined,
  authorization: "初始化中" | "增强记忆" | "已阻断",
): string {
  const configured = setting ? `${setting.provider}/${setting.model}` : "not configured";
  const running = state?.activeProvider && state.activeModel ? `${state.activeProvider}/${state.activeModel}` : "no VLM loaded";
  const applied = Boolean(state?.serviceReady && (setting
    ? state.activeSettingsFingerprint === memoryModelSettingsFingerprint(setting)
    : state.activeProvider === undefined
      && state.activeModel === undefined
      && state.activeSettingsFingerprint === undefined));
  const configurationStatus = applied
    ? "applied"
    : state
      ? "waiting for /restart-viking"
      : "launcher unavailable";
  return [
    `Configuration file: ${configPath}`,
    `Configured memory model: ${configured}`,
    `Running OpenViking model: ${running}`,
    `Service readiness: ${state?.serviceReady ? "ready" : state?.phase ?? "launcher unavailable"}`,
    `Memory runtime profile: ${state?.activeProfileFingerprint ?? "unavailable"}`,
    `Memory capability: ${state?.memoryCapability ? "verified for current process" : "unavailable"}`,
    `Request readiness: ${state?.requestReady ? "ready" : "blocked"}`,
    `Configuration: ${configurationStatus}`,
    state?.configurationError ? `Configuration error: ${state.configurationError}` : undefined,
    state?.error ? `Runtime error: ${state.error}` : undefined,
    `Extension authorization: ${authorization}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}


export default function piContextMemoryProbe(pi: ExtensionAPI): void {
  function providerPayloadProfile(ctx: ExtensionContext): ProviderPayloadProfile {
    const model = ctx.model;
    if (!model) throw new Error("Task Provider model is unavailable");
    const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    const tools = pi.getActiveTools().map((name) => {
      const tool = toolsByName.get(name);
      if (!tool) throw new Error(`Active Pi tool is unavailable: ${name}`);
      return { name: tool.name, description: tool.description, parameters: tool.parameters };
    });
    return createProviderPayloadProfile({
      provider: model.provider,
      model: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      compat: model.compat ?? null,
      contextWindowTokens: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      systemPrompt: ctx.getSystemPrompt(),
      tools,
    });
  }

  function providerPayloadProfileFault(error: unknown): ContextFault {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: /no verified provider payload adapter/iu.test(detail)
        ? "opaque-content-unrepresentable"
        : /budget|context window|maximum output/iu.test(detail) ? "budget" : "service",
      detail,
    };
  }

  function workingContextFault(error: unknown): ContextFault {
    const detail = error instanceof Error ? error.message : String(error);
    if (/abort|cancel|timed out|timeout|deadline/iu.test(detail)) return { kind: "timeout", detail };
    if (/source|archive|blob|ENOTDIR|ENOENT|entry/iu.test(detail)) return { kind: "source-barrier", detail };
    if (/route|branch|leaf|fingerprint|watermark/iu.test(detail)) return { kind: "route", detail };
    if (/budget|limit|exceeded/iu.test(detail)) return { kind: "budget", detail };
    return { kind: "service", detail };
  }
  let openVikingUrl: string | undefined;
  let openVikingEndpointError: string | undefined;
  try {
    openVikingUrl = configuredOpenVikingBaseUrl(projectRoot);
  } catch (error) {
    openVikingEndpointError = error instanceof Error ? error.message : String(error);
    writeRecord("source_index_config_error", { error: openVikingEndpointError });
  }
  let sourceRecall: OpenVikingSourceRecall | undefined;
  if (openVikingUrl) {
    try {
      sourceRecall = new OpenVikingSourceRecall(openVikingUrl, openVikingApiKey, openVikingTimeoutMs);
    } catch (error) {
      openVikingEndpointError = error instanceof Error ? error.message : String(error);
      writeRecord("source_index_config_error", { error: openVikingEndpointError });
    }
  }
  let sessionWorkingMemory: OpenVikingSessionMemory | undefined;
  let workingContextOptimizer: WorkingContextOptimizer | undefined;
  let workingContextGeneration: string | undefined;
  let workingContextCapabilityProofId: string | undefined;
  let workingContextTransition: Promise<void> = Promise.resolve();
  let coordinator: SessionMemoryCoordinator | undefined;
  let coordinatorIdentity: string | undefined;
  const latchedGenerationFaults = new Map<string, LatchedGenerationFault>();
  let archiveRunning = false;
  let sourceIndexUnavailable = sourceRecall === undefined;
  let sourceIndexFailureNotified = false;
  const archiveQueue: Array<{
    key: string;
    coordinator: SessionMemoryCoordinator;
    snapshot: SessionRouteSnapshot;
    trigger: string;
    ctx: ExtensionContext;
    generation: string | undefined;
  }> = [];
  const archiveIdleWaiters = new Set<() => void>();
  const queuedArchives = new Set<string>();
  let lastMemoryModelConfigDiagnosticKey: string | undefined;
  let memoryModelConfigCheck: Promise<void> | undefined;
  let memoryEnhancementAvailable = false;
  let lastAuthorization: "初始化中" | "增强记忆" | "已阻断" = "初始化中";
  let renderedMemoryUiState: MemoryUiState | undefined;
  let contextAuthorizationOutcome: "pending" | "allowed" | "blocked" = "pending";
  let pendingAssemblyProof: PendingRequestProof | undefined;
  let pendingCompactionDecision: { reason: "manual" | "threshold" | "overflow"; branchLeafId: string | null } | undefined;
  let pendingTreeDecision: {
    targetId: string;
    oldLeafId: string | null;
    userWantsSummary: boolean;
    decision: "unchanged" | "empty-summary";
  } | undefined;
  let footerInstalled = false;
  let shuttingDown = false;
  let archiveStopped = false;
  let memoryModelWatchEpoch = 0;
  let memoryModelRecheckRequested = false;
  let watchedMemoryModelRoot: string | undefined;
  let memoryModelWatchReady = false;
  let memoryModelWatchSignature: string | undefined;
  let latestMemoryModelContext: ExtensionContext | undefined;
  const memoryModelWatchers: FSWatcher[] = [];

  function closeMemoryModelWatchers(): void {
    while (memoryModelWatchers.length > 0) memoryModelWatchers.pop()?.close();
    watchedMemoryModelRoot = undefined;
    memoryModelWatchReady = false;
    memoryModelWatchSignature = undefined;
  }

  function requestMemoryModelRecheck(reason: string): void {
    const hadGeneration = memoryEnhancementAvailable || Boolean(workingContextGeneration);
    memoryModelWatchEpoch += 1;
    memoryModelRecheckRequested = true;
    if (hadGeneration) writeRecord("memory_model_generation_recheck", { reason });
    const activeContext = latestMemoryModelContext;
    if (activeContext && !shuttingDown) scheduleMemoryModelConfigCheck(activeContext, true);
  }

  function ensureMemoryModelWatchers(root: string, ctx: ExtensionContext): boolean {
    latestMemoryModelContext = ctx;
    const paths = runtimePaths(root);
    const watchedFiles = [paths.settings, paths.state];
    try {
      const resolvedSettings = realpathSync(paths.settings);
      if (resolvedSettings !== paths.settings) watchedFiles.push(resolvedSettings);
    } catch {
      // A missing or dangling settings target is rejected by configuration validation.
    }
    const signature = JSON.stringify([...new Set(watchedFiles)].sort());
    if (watchedMemoryModelRoot === root && memoryModelWatchReady && memoryModelWatchSignature === signature) return true;
    closeMemoryModelWatchers();
    const filesByDirectory = new Map<string, Set<string>>();
    for (const path of watchedFiles) {
      const directory = dirname(path);
      const files = filesByDirectory.get(directory) ?? new Set<string>();
      files.add(basename(path));
      filesByDirectory.set(directory, files);
    }
    for (const [directory, files] of filesByDirectory) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename !== null && !files.has(filename.toString())) return;
          requestMemoryModelRecheck(`changed:${filename?.toString() ?? "unknown"}`);
        });
        watcher.on("error", (error) => {
          writeRecord("memory_model_watch_error", {
            directory,
            error: error instanceof Error ? error.message : String(error),
          });
          closeMemoryModelWatchers();
          requestMemoryModelRecheck(`watch-error:${directory}`);
        });
        watcher.on("close", () => {
          if (!memoryModelWatchers.includes(watcher)) return;
          writeRecord("memory_model_watch_error", { directory, error: "watcher closed unexpectedly" });
          closeMemoryModelWatchers();
          requestMemoryModelRecheck(`watch-close:${directory}`);
        });
        memoryModelWatchers.push(watcher);
      } catch (error) {
        writeRecord("memory_model_watch_error", {
          directory,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    watchedMemoryModelRoot = root;
    memoryModelWatchSignature = signature;
    memoryModelWatchReady = memoryModelWatchers.length === filesByDirectory.size;
    return memoryModelWatchReady;
  }

  function transitionWorkingContext(state?: OpenVikingRuntimeState): Promise<boolean> {
    const nextGeneration = memoryRuntimeGenerationFromState(state);
    const nextCapabilityProofId = nextGeneration ? state?.memoryCapability?.proofId : undefined;
    const transition = async (): Promise<boolean> => {
      clearFaultForNewGeneration(nextGeneration);
      if (nextGeneration
        && nextCapabilityProofId
        && !shuttingDown
        && sessionWorkingMemory
        && workingContextOptimizer
        && workingContextGeneration === nextGeneration
        && workingContextCapabilityProofId === nextCapabilityProofId) {
        return true;
      }
      const previousMemory = sessionWorkingMemory;
      sessionWorkingMemory = undefined;
      workingContextOptimizer = undefined;
      workingContextGeneration = undefined;
      workingContextCapabilityProofId = undefined;
      coordinator = undefined;
      coordinatorIdentity = undefined;
      if (previousMemory) await previousMemory.shutdown(new Error("Working context runtime generation changed"));
      if (!nextGeneration || !nextCapabilityProofId || !state?.activeProfile || shuttingDown) return false;
      if (!openVikingUrl) {
        writeRecord("working_context_config_error", {
          error: openVikingEndpointError ?? "OpenViking endpoint is unavailable",
        });
        return false;
      }
      try {
        sessionWorkingMemory = new OpenVikingSessionMemory(openVikingUrl, openVikingApiKey, openVikingTimeoutMs, {
          generation: nextGeneration,
          capabilityProofId: nextCapabilityProofId,
          commitPendingTokens: checkpointCommitPendingTokens,
          taskTimeoutMs: state.activeProfile.requestTimeoutMs,
        });
        workingContextOptimizer = new WorkingContextOptimizer();
        workingContextGeneration = nextGeneration;
        workingContextCapabilityProofId = nextCapabilityProofId;
        return true;
      } catch (error) {
        writeRecord("working_context_config_error", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    };
    const operation = workingContextTransition.then(transition, transition);
    workingContextTransition = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function setAuthorization(value: "初始化中" | "增强记忆" | "已阻断"): void {
    lastAuthorization = value;
  }

  /** 未到达 before_provider_request 的 constructed 输出记为 unobserved。 */
  function retireUnobservedProof(reason: string): void {
    if (!pendingAssemblyProof) return;
    const nonce = pendingAssemblyProof.assembly.nonce;
    pendingAssemblyProof = undefined;
    writeRecord("constructed_output_unobserved", { nonce, reason });
  }

  function setMemoryUiState(ctx: ExtensionContext, state: MemoryUiState): void {
    if (renderedMemoryUiState === state) return;
    renderedMemoryUiState = state;
    if (ctx.hasUI) ctx.ui.setStatus("pi-context-memory", MEMORY_UI_TEXT[state]);
  }

  function currentSessionKey(ctx: ExtensionContext): string | undefined {
    const identity = sessionIdentity(ctx);
    return identity ? `${identity.sessionId}\0${identity.sessionFile}` : undefined;
  }

  function generationFaultKey(generation: string | undefined, sessionKey: string | undefined): string {
    return `${generation ?? "unavailable"}\0${sessionKey ?? "runtime"}`;
  }

  function applicableGenerationFault(ctx: ExtensionContext): LatchedGenerationFault | undefined {
    const runtimeFault = latchedGenerationFaults.get(generationFaultKey(workingContextGeneration, undefined));
    if (runtimeFault) return runtimeFault;
    return latchedGenerationFaults.get(generationFaultKey(workingContextGeneration, currentSessionKey(ctx)));
  }

  function latchGenerationFault(
    ctx: ExtensionContext,
    stage: LatchedGenerationFault["stage"],
    fault: ContextFault,
    options: { generation?: string; sessionScoped?: boolean } = {},
  ): void {
    const generation = options.generation ?? workingContextGeneration;
    if (generation !== workingContextGeneration) {
      writeRecord("generation_fault_ignored", { generation, currentGeneration: workingContextGeneration, stage, fault: fault.kind });
      return;
    }
    const sessionKey = options.sessionScoped ? currentSessionKey(ctx) : undefined;
    const key = generationFaultKey(generation, sessionKey);
    if (latchedGenerationFaults.has(key)) return;
    latchedGenerationFaults.set(key, { generation, stage, fault, sessionKey });
    contextAuthorizationOutcome = "blocked";
    retireUnobservedProof(`${stage} fault`);
    setAuthorization("已阻断");
    setMemoryUiState(ctx, "faulted");
    writeRecord("generation_fault_latched", {
      generation,
      sessionKey: sessionKey ? hash(sessionKey) : undefined,
      stage,
      fault: fault.kind,
      detail: fault.detail,
    });
  }

  function clearFaultForNewGeneration(nextGeneration: string | undefined): void {
    if (!nextGeneration) return;
    for (const [key, fault] of latchedGenerationFaults) {
      if (fault.generation === nextGeneration) continue;
      writeRecord("generation_fault_replaced", {
        previousGeneration: fault.generation,
        nextGeneration,
        stage: fault.stage,
        fault: fault.fault.kind,
      });
      latchedGenerationFaults.delete(key);
    }
  }

  async function reportMemoryModelConfigError(ctx: ExtensionContext, checkEpoch: number): Promise<void> {
    let root: string | undefined;
    let state: OpenVikingRuntimeState | undefined;
    let contentFingerprint: string | undefined;
    let diagnosticMessage: string | undefined;
    try {
      root = await locateProjectRoot(ctx.cwd);
      if (!ensureMemoryModelWatchers(root, ctx)) diagnosticMessage = "Memory model generation watching is unavailable";
      state = await readRuntimeState(root);
    } catch (error) {
      diagnosticMessage = error instanceof Error ? error.message : String(error);
    }

    if (!shuttingDown && checkEpoch === memoryModelWatchEpoch) {
      const generation = memoryRuntimeGenerationFromState(state);
      const previousGeneration = workingContextGeneration;
      const wasAvailable = memoryEnhancementAvailable;
      const generationReady = await transitionWorkingContext(state);
      if (!shuttingDown && checkEpoch === memoryModelWatchEpoch) {
        memoryEnhancementAvailable = Boolean(generation && generationReady && root);
        if (memoryEnhancementAvailable) {
          if (!wasAvailable || previousGeneration !== generation) {
            setMemoryUiState(ctx, "initializing");
            scheduleCheckpointRefresh(ctx, sessionRouteSnapshot(ctx), "runtime_ready");
          }
        } else {
          const runtimeStarting = state?.phase === "starting" || state?.phase === "restarting";
          setMemoryUiState(ctx, runtimeStarting ? "initializing" : "faulted");
        }
      }
    }

    if (root) {
      contentFingerprint = await memoryModelConfigContentFingerprint(root);
      try {
        await validateMemoryModelSetting(root);
      } catch (error) {
        diagnosticMessage ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (diagnosticMessage) {
      const diagnosticKey = `${contentFingerprint ?? "unreadable"}:${hash(diagnosticMessage)}`;
      if (diagnosticKey !== lastMemoryModelConfigDiagnosticKey) {
        lastMemoryModelConfigDiagnosticKey = diagnosticKey;
        writeRecord("memory_model_config_error", { error: diagnosticMessage, contentFingerprint });
        const continuation = memoryRuntimeGenerationFromState(state)
          ? "The running OpenViking instance remains available until restart."
          : "Enhanced requests remain blocked until memory runtime validation succeeds.";
        if (ctx.hasUI) ctx.ui.notify(`${diagnosticMessage}\n${continuation}`, "warning");
      }
    } else {
      lastMemoryModelConfigDiagnosticKey = undefined;
    }
  }

  function scheduleMemoryModelConfigCheck(ctx: ExtensionContext, force = false): Promise<void> | undefined {
    latestMemoryModelContext = ctx;
    if (shuttingDown || memoryModelConfigCheck || (!force && memoryEnhancementAvailable)) return memoryModelConfigCheck;
    const checkEpoch = memoryModelWatchEpoch;
    memoryModelRecheckRequested = false;
    if (!memoryEnhancementAvailable && renderedMemoryUiState !== "faulted") setMemoryUiState(ctx, "initializing");
    memoryModelConfigCheck = reportMemoryModelConfigError(ctx, checkEpoch).catch(() => undefined).finally(() => {
      memoryModelConfigCheck = undefined;
      if (memoryModelRecheckRequested && latestMemoryModelContext && !shuttingDown) {
        memoryModelRecheckRequested = false;
        scheduleMemoryModelConfigCheck(latestMemoryModelContext, true);
      }
    });
    return memoryModelConfigCheck;
  }

  async function refreshMemoryRuntimeState(ctx: ExtensionContext): Promise<void> {
    let pending = scheduleMemoryModelConfigCheck(ctx, true);
    while (pending) {
      await pending;
      const next = memoryModelConfigCheck;
      if (!next || next === pending) return;
      pending = next;
    }
  }
  function currentCoordinator(ctx: ExtensionContext): SessionMemoryCoordinator | undefined {
    const identity = sessionIdentity(ctx);
    if (!identity || !sessionWorkingMemory || !workingContextGeneration) return undefined;
    const key = `${identity.sessionId}\0${identity.sessionFile}\0${workingContextGeneration}`;
    if (!coordinator || coordinatorIdentity !== key) {
      coordinator = new SessionMemoryCoordinator(
        identity,
        new FileLongTermMemory(archiveRoot(ctx), archiveCopyTimeoutMs),
        PI_PROTOCOL_PROFILE,
        sessionWorkingMemory,
      );
      coordinatorIdentity = key;
    }
    return coordinator;
  }

  function scheduleCheckpointRefresh(
    ctx: ExtensionContext,
    snapshot: SessionRouteSnapshot | undefined,
    trigger: string,
  ): void {
    if (shuttingDown
      || applicableGenerationFault(ctx)
      || !memoryEnhancementAvailable
      || !workingContextOptimizer
      || !sessionWorkingMemory
      || !snapshot
      || snapshot.entries.length === 0) return;
    const activeCoordinator = currentCoordinator(ctx);
    if (!activeCoordinator) return;
    let route: SessionRouteIdentity;
    let retentionBudgetIdentity: string;
    try {
      if (!activeCoordinator.projectCurrentRoute(snapshot).projections.some(isMessageSource)) return;
      route = activeCoordinator.identifyCurrentRoute(snapshot);
      retentionBudgetIdentity = createRetentionBudgetIdentity(
        providerPayloadProfile(ctx),
        activeCoordinator.checkpointRetentionPolicy(),
      );
    } catch (error) {
      writeRecord("checkpoint_refresh_rejected", {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void activeCoordinator.scheduleCheckpointRefresh(snapshot, retentionBudgetIdentity, { required: false }).then(
      (result) => {
        writeRecord("checkpoint_refresh_complete", {
          trigger,
          sessionId: route.sessionId,
          sessionFile: route.sessionFile,
          leafId: route.leafId,
          routeFingerprint: route.fingerprint,
          outcome: result.kind,
          checkpointIdentity: result.kind === "accepted" ? result.checkpoint.identity : undefined,
          openVikingSessionId: result.kind === "accepted" ? result.checkpoint.openVikingSessionId : undefined,
          hasWorkingMemory: result.kind === "accepted" ? result.checkpoint.workingMemory.length > 0 : false,
        });
      },
      (error) => {
        const fault = workingContextFault(error);
        const detail = fault.detail;
        writeRecord("checkpoint_refresh_error", {
          trigger,
          sessionId: route.sessionId,
          sessionFile: route.sessionFile,
          leafId: route.leafId,
          routeFingerprint: route.fingerprint,
          required: false,
          fault: fault.kind,
          error: detail,
        });
      },
    );
  }

  async function runSourceIndex(
    activeCoordinator: SessionMemoryCoordinator,
    snapshot: SessionRouteSnapshot,
    trigger: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!sourceRecall) return;
    try {
      const sources = await activeCoordinator.listCurrentSources(snapshot);
      await sourceRecall.synchronize(sources, signal);
      sourceIndexUnavailable = false;
      sourceIndexFailureNotified = false;
      writeRecord("source_index_complete", {
        trigger,
        sessionId: snapshot.sessionId,
        leafId: snapshot.leafId,
        sourceCount: sources.length,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      sourceIndexUnavailable = true;
      writeRecord("source_index_error", {
        trigger,
        sessionId: snapshot.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const sourceIndexes = new SessionSourceIndexCoordinator(runSourceIndex);

  async function runArchive(
    activeCoordinator: SessionMemoryCoordinator,
    snapshot: SessionRouteSnapshot,
    trigger: string,
    ctx: ExtensionContext,
    generation: string | undefined,
  ): Promise<void> {
    try {
      if (archiveDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, archiveDelayMs));
      if (!await hasAuthoritativeSessionFile(snapshot)) {
        writeRecord("archive_skipped", { trigger, sessionId: snapshot.sessionId, reason: "session_not_persisted" });
        return;
      }
      const result = await activeCoordinator.archiveCurrentRoute(snapshot);
      writeRecord("archive_complete", {
        trigger,
        sessionId: snapshot.sessionId,
        leafId: snapshot.leafId,
        sourceCount: snapshot.entries.length,
        largeResults: result.archivedFullOutputEntryIds.length,
      });
      if (!shuttingDown) sourceIndexes.scheduleBackground(activeCoordinator, snapshot, trigger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      latchGenerationFault(ctx, "archive", { kind: "source-barrier", detail: message }, {
        generation,
        sessionScoped: true,
      });
      writeRecord("archive_error", { trigger, sessionId: snapshot.sessionId, error: message });
    }
  }

  function pumpArchiveQueue(): void {
    if (archiveRunning || archiveStopped) return;
    const job = archiveQueue.shift();
    if (!job) {
      for (const resolveIdle of archiveIdleWaiters) resolveIdle();
      archiveIdleWaiters.clear();
      return;
    }
    archiveRunning = true;
    void runArchive(job.coordinator, job.snapshot, job.trigger, job.ctx, job.generation).finally(() => {
      queuedArchives.delete(job.key);
      archiveRunning = false;
      pumpArchiveQueue();
    });
  }

  function waitForArchiveIdle(): Promise<void> {
    if (!archiveRunning && archiveQueue.length === 0) return Promise.resolve();
    return new Promise((resolveIdle) => archiveIdleWaiters.add(resolveIdle));
  }

  function stopArchiveQueue(): void {
    archiveStopped = true;
    for (const job of archiveQueue.splice(0)) queuedArchives.delete(job.key);
    for (const resolveIdle of archiveIdleWaiters) resolveIdle();
    archiveIdleWaiters.clear();
  }

  function scheduleArchive(ctx: ExtensionContext, trigger: string): void {
    if (shuttingDown
      || archiveStopped
      || applicableGenerationFault(ctx)) return;
    if (sourceIndexUnavailable && !sourceIndexFailureNotified && ctx.hasUI) {
      ctx.ui.notify("Session recall indexing is unavailable; Pi will continue normally.", "warning");
      sourceIndexFailureNotified = true;
    }
    const snapshot = sessionRouteSnapshot(ctx);
    const activeCoordinator = currentCoordinator(ctx);
    if (!snapshot || !activeCoordinator) {
      writeRecord("archive_skipped", { trigger, reason: "ephemeral_session" });
      return;
    }
    const key = `${snapshot.sessionId}\0${snapshot.leafId ?? ""}`;
    if (queuedArchives.has(key)) return;
    queuedArchives.add(key);
    archiveQueue.push({
      key,
      coordinator: activeCoordinator,
      snapshot,
      trigger,
      ctx,
      generation: workingContextGeneration,
    });
    pumpArchiveQueue();
  }

  pi.registerCommand("memory-model", {
    description: "Inspect the user OpenViking memory model configuration",
    handler: async (args, ctx) => {
      let root: string | undefined;
      try {
        if (args.trim()) throw new Error("Usage: /memory-model. Edit the reported JSONC file to change the model.");
        root = await locateProjectRoot(ctx.cwd);
        const configPath = memoryModelConfigPath(root);
        const setting = await validateMemoryModelSetting(root);
        const state = await readRuntimeState(root);
        lastMemoryModelConfigDiagnosticKey = undefined;
        ctx.ui.notify(formatMemoryModelState(configPath, setting, state, lastAuthorization), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (root && message.startsWith("Invalid memory model configuration at ")) {
          const contentFingerprint = await memoryModelConfigContentFingerprint(root);
          lastMemoryModelConfigDiagnosticKey = `${contentFingerprint ?? "unreadable"}:${hash(message)}`;
        }
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("restart-viking", {
    description: "Apply the user memory model configuration to the managed OpenViking instance",
    handler: async (_args, ctx) => {
      let root: string | undefined;
      const uiStateBeforeRestart = renderedMemoryUiState;
      try {
        root = await locateProjectRoot(ctx.cwd);
        contextAuthorizationOutcome = "pending";
        retireUnobservedProof("lifecycle reset");
        setAuthorization("初始化中");
        if (memoryModelConfigCheck) await memoryModelConfigCheck;
        setMemoryUiState(ctx, "initializing");
        const state = await requestOpenVikingRestart(root);
        const generation = memoryRuntimeGenerationFromState(state);
        const generationReady = await transitionWorkingContext(state);
        memoryEnhancementAvailable = Boolean(generation && generationReady);
        if (memoryEnhancementAvailable) {
          setMemoryUiState(ctx, "initializing");
          scheduleCheckpointRefresh(ctx, sessionRouteSnapshot(ctx), "restart");
        } else {
          const runtimeStarting = state.phase === "starting" || state.phase === "restarting";
          setMemoryUiState(ctx, runtimeStarting ? "initializing" : "faulted");
        }
        writeRecord("openviking_restart_complete", {
          provider: state.activeProvider,
          model: state.activeModel,
          configFingerprint: state.activeConfigFingerprint,
        });
        ctx.ui.notify(`OpenViking ready: ${state.activeProvider ?? "no VLM"}/${state.activeModel ?? "source recall only"}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = root ? await readRuntimeState(root).catch(() => undefined) : undefined;
        const generation = memoryRuntimeGenerationFromState(state);
        const generationReady = await transitionWorkingContext(state);
        memoryEnhancementAvailable = Boolean(generation && generationReady);
        if (memoryEnhancementAvailable) {
          setMemoryUiState(ctx, uiStateBeforeRestart === "active" ? "active" : "initializing");
        } else {
          setMemoryUiState(ctx, "faulted");
        }
        if (root && message.startsWith("Invalid memory model configuration at ")) {
          const contentFingerprint = await memoryModelConfigContentFingerprint(root);
          lastMemoryModelConfigDiagnosticKey = `${contentFingerprint ?? "unreadable"}:${hash(message)}`;
        }
        writeRecord("openviking_restart_error", { error: message });
        ctx.ui.notify(message, "error");
      } finally {
        contextAuthorizationOutcome = "pending";
        retireUnobservedProof("lifecycle reset");
        setAuthorization("初始化中");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    setAuthorization("初始化中");
    scheduleMemoryModelConfigCheck(ctx);
  });

  pi.registerTool({
    name: "recall_session",
    label: "Recall Session",
    description: "Search sources archived from the current persisted Pi session, or expand one source by entry ID. Search results are restricted to the current branch and bounded to 10 results; OpenViking ranks candidates but Pi entries remain authoritative.",
    promptSnippet: "Search or expand early sources from the current Pi session when details have left the active context",
    promptGuidelines: [
      "Use recall_session when exact earlier constraints, decisions, errors, or evidence may have left the active context; use read_source before relying on a truncated preview for a critical fact.",
    ],
    parameters: recallParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const snapshot = sessionRouteSnapshot(ctx);
      const activeCoordinator = currentCoordinator(ctx);
      if (!snapshot || !activeCoordinator) {
        throw new Error("Session recall requires a persisted Pi session");
      }
      try {
        await activeCoordinator.archiveCurrentRoute(snapshot);

      if (params.action === "read_source") {
        const entryId = params.entry_id?.trim();
        if (!entryId) throw new Error("read_source requires entry_id");
        const resolved = await activeCoordinator.resolveCurrentSource(snapshot, entryId);
        if (!resolved) {
          return {
            content: [{ type: "text", text: `Source ${entryId} is not available on the current branch.` }],
            details: { action: params.action, entryId, available: false },
          };
        }
        const maxChars = params.max_chars ?? RECALL_LIMITS.expansionDefaultChars;
        const fullOutput = await activeCoordinator.readCurrentFullOutput(snapshot, entryId, maxChars);
        const expansion = expandSource(resolved.projection, maxChars, fullOutput);
        writeRecord("source_recall_expand", {
          sessionId: snapshot.sessionId,
          entryId,
          truncated: expansion.truncated,
          contentBytes: Buffer.byteLength(expansion.content, "utf8"),
        });
        return {
          content: [{
            type: "text",
            text: [
              `Pi source entry: ${entryId}`,
              `truncated: ${expansion.truncated}`,
              "",
              expansion.content,
            ].join("\n"),
          }],
          details: { action: params.action, entryId, available: true, truncated: expansion.truncated },
        };
      }

      const query = params.query?.trim();
      if (!query) throw new Error("search requires query");
      if (!sourceRecall) throw new Error("Session recall is unavailable because OpenViking configuration is invalid");
      const searchSnapshot = snapshotBeforeCurrentPrompt(snapshot);
      const sources = await activeCoordinator.listCurrentSources(searchSnapshot);
      if (sources.length === 0) {
        return {
          content: [{ type: "text", text: "No archived sources are available before the current prompt." }],
          details: { action: params.action, hits: 0, backendCandidates: 0, currentRouteCandidates: 0 },
        };
      }
      try {
        await sourceIndexes.synchronizeAfterInvocation(activeCoordinator, searchSnapshot, signal);
        const result = await sourceRecall.searchCurrent(
          searchSnapshot,
          sources,
          query,
          params.limit ?? RECALL_LIMITS.resultDefault,
          signal,
        );
        writeRecord("source_recall_search", {
          sessionId: snapshot.sessionId,
          queryHash: hash(query),
          hits: result.hits.length,
          backendCandidates: result.backendCandidates,
          currentRouteCandidates: result.currentRouteCandidates,
        });
        return {
          content: [{ type: "text", text: formatSearchResult(result) }],
          details: {
            action: params.action,
            hits: result.hits.length,
            backendCandidates: result.backendCandidates,
            currentRouteCandidates: result.currentRouteCandidates,
            entryIds: result.hits.map((hit) => hit.entryId),
          },
        };
      } catch (error) {
        throw new Error(`Session recall is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!signal?.aborted
          && !message.includes("requires entry_id")
          && !message.includes("requires query")) {
          latchGenerationFault(
            ctx,
            params.action === "search" ? "source-index" : "archive",
            { kind: params.action === "search" ? "service" : "source-barrier", detail: message },
            { sessionScoped: true },
          );
        }
        throw error;
      }
    },
  });
  pi.on("session_start", (event, ctx) => {
    writeRecord("session_start", { reason: event.reason, previousSessionFile: event.previousSessionFile, mode: ctx.mode, ...branchSnapshot(ctx) });
    footerInstalled = installEnhancedFooter(ctx, (snapshot) => writeRecord("footer_rendered", { snapshot }));
    writeRecord("footer_adapter", { action: footerInstalled ? "installed" : "not-installed", mode: ctx.mode });
    maybeFail("session_start");
    scheduleArchive(ctx, "session_start");
  });

  pi.on("input", (event, ctx) => {
    writeRecord("input", { source: event.source, textBytes: Buffer.byteLength(event.text, "utf8"), images: event.images?.length ?? 0, ...branchSnapshot(ctx) });
    maybeFail("input");
  });

  pi.on("before_agent_start", (event, ctx) => {
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    setAuthorization("初始化中");
    scheduleMemoryModelConfigCheck(ctx);
    const workingSnapshot = sessionRouteSnapshot(ctx);
    scheduleCheckpointRefresh(
      ctx,
      workingSnapshot ? snapshotBeforeCurrentPrompt(workingSnapshot) : undefined,
      "before_agent_start",
    );
    writeRecord("before_agent_start", {
      promptBytes: Buffer.byteLength(event.prompt, "utf8"),
      systemPromptBytes: Buffer.byteLength(event.systemPrompt, "utf8"),
      selectedTools: event.systemPromptOptions.selectedTools,
      contextFiles: event.systemPromptOptions.contextFiles?.map((file) => file.path) ?? [],
      skills: event.systemPromptOptions.skills?.map((skill) => skill.name) ?? [],
      ...branchSnapshot(ctx),
    });
    maybeFail("before_agent_start");
  });

  pi.on("agent_start", (_event, ctx) => {
    writeRecord("agent_start", branchSnapshot(ctx));
    maybeFail("agent_start");
  });

  pi.on("turn_start", (event, ctx) => {
    writeRecord("turn_start", { turnIndex: event.turnIndex, timestamp: event.timestamp, ...branchSnapshot(ctx) });
    maybeFail("turn_start");
  });

  pi.on("context", async (event, ctx) => {
    retireUnobservedProof("superseded by a new context request");
    await refreshMemoryRuntimeState(ctx);
    const snapshot = sessionRouteSnapshot(ctx);
    const activeCoordinator = currentCoordinator(ctx);
    const generationCurrent = memoryEnhancementAvailable
      && Boolean(workingContextOptimizer && workingContextGeneration);

    let authorization: ContextAuthorization<unknown>;
    const activeFault = applicableGenerationFault(ctx);
    if (activeFault) {
      authorization = { kind: "block", fault: activeFault.fault };
    } else if (!generationCurrent || !workingContextOptimizer) {
      authorization = { kind: "block", fault: { kind: "not-ready", detail: "Enhanced memory generation is not active" } };
    } else if (!snapshot || !activeCoordinator) {
      authorization = { kind: "block", fault: { kind: "route", detail: "The current Pi session route is unavailable" } };
    } else {
      try {
        const currentProjection = activeCoordinator.projectCurrentRoute(snapshot);
        let currentFault: ContextFault | undefined = currentProjection.projections
          .some((projection) => isOpaqueProviderSegment(projection) && projection.reason === "tool-protocol")
          ? { kind: "tool-protocol", detail: "The current Pi route contains an incomplete or mismatched ToolBatch" }
          : undefined;
        if (!currentFault && currentProjection.fullOutputCandidates.length > 0) {
          try {
            if (!await hasAuthoritativeSessionFile(snapshot)) {
              throw new Error("Full output requires a persisted authoritative Pi session");
            }
            await activeCoordinator.archiveCurrentRoute(snapshot);
          } catch (error) {
            currentFault = {
              kind: "source-barrier",
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }
        let payloadProfile: ProviderPayloadProfile | undefined;
        if (!currentFault) {
          try {
            payloadProfile = providerPayloadProfile(ctx);
          } catch (error) {
            currentFault = providerPayloadProfileFault(error);
          }
        }
        if (currentFault) {
          authorization = { kind: "block", fault: currentFault };
        } else {
          let requestSnapshot = snapshot;
          const initialRouteFingerprint = activeCoordinator.identifyCurrentRoute(snapshot).fingerprint;
          const messageSourcesByEntryId = new Map(currentProjection.projections
            .filter(isMessageSource)
            .map((projection) => [projection.id, projection]));
          const messages = sanitizeFullOutputLocators(
            event.messages as unknown[],
            currentProjection.fullOutputCandidates,
          );
          let currentProfile = payloadProfile!;
          authorization = { kind: "block", fault: { kind: "service", detail: "Historical context was not evaluated" } };
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const historicalSnapshot = snapshotBeforeCurrentPrompt(requestSnapshot);
            const retentionBudgetIdentity = createRetentionBudgetIdentity(
              currentProfile,
              activeCoordinator.checkpointRetentionPolicy(),
            );
            const historical = await activeCoordinator.resolveHistoricalContext(
              historicalSnapshot,
              retentionBudgetIdentity,
            );
            authorization = await workingContextOptimizer.authorize({
              generation: workingContextGeneration,
              requestRoute: activeCoordinator.identifyCurrentRoute(requestSnapshot),
              historical,
              messages,
              providerPayloadProfile: currentProfile,
              toolSources: currentTurnToolSources(requestSnapshot.entries, messageSourcesByEntryId),
              toProviderMessages: (providerMessages) => convertToLlm(providerMessages as never[]) as unknown[],
              ensureSources: (entryIds) => activeCoordinator.ensureCurrentSourcesRecoverable(requestSnapshot, entryIds),
              signal: ctx.signal,
            });
            if (authorization.kind !== "refresh-required") break;
            const refresh = await activeCoordinator.scheduleCheckpointRefresh(
              historicalSnapshot,
              retentionBudgetIdentity,
              { required: true, signal: ctx.signal },
            );
            if (refresh.kind !== "accepted") {
              authorization = {
                kind: "block",
                fault: { kind: "service", detail: "Required checkpoint refresh did not publish a checkpoint" },
              };
              break;
            }
            const liveSnapshot = sessionRouteSnapshot(ctx);
            if (!liveSnapshot
              || activeCoordinator.identifyCurrentRoute(liveSnapshot).fingerprint !== initialRouteFingerprint) {
              authorization = {
                kind: "block",
                fault: { kind: "route", detail: "The Pi route changed while waiting for a checkpoint refresh" },
              };
              break;
            }
            requestSnapshot = liveSnapshot;
            currentProfile = providerPayloadProfile(ctx);
          }
          if (authorization.kind === "refresh-required") {
            authorization = {
              kind: "block",
              fault: { kind: "budget", detail: "The refreshed checkpoint still cannot satisfy the Provider payload budget" },
            };
          }
        }
      } catch (error) {
        authorization = {
          kind: "block",
          fault: workingContextFault(error),
        };
      }
    }

    if (authorization.kind === "refresh-required") {
      authorization = {
        kind: "block",
        fault: { kind: "budget", detail: "Checkpoint refresh did not resolve the historical context requirement" },
      };
    }
    let requestProof: PendingRequestProof | undefined;
    if (authorization.kind === "allow") {
      const model = ctx.model;
      const payloadProof = model?.api === "openai-completions"
        ? createOpenAICompletionsPayloadProof(
          model.provider,
          model.id,
          convertToLlm(authorization.enhancedContext as never[]) as unknown[],
        )
        : undefined;
      if (!payloadProof) {
        authorization = {
          kind: "block",
          fault: {
            kind: "opaque-content-unrepresentable",
            detail: `No verified Provider payload adapter is available for ${model?.api ?? "unknown API"}`,
          },
        };
      } else if (!workingContextCapabilityProofId) {
        authorization = {
          kind: "block",
          fault: { kind: "not-ready", detail: "Memory capability proof identity is unavailable" },
        };
      } else {
        requestProof = {
          assembly: authorization.proof,
          payload: payloadProof,
          memoryCapabilityProofId: workingContextCapabilityProofId,
        };
      }
    }

    if (authorization.kind === "block") {
      if (!applicableGenerationFault(ctx)
        && ["service", "source-barrier", "tool-protocol"].includes(authorization.fault.kind)) {
        latchGenerationFault(ctx, "working-context", authorization.fault, {
          sessionScoped: authorization.fault.kind !== "service",
        });
      }
      contextAuthorizationOutcome = "blocked";
      setAuthorization("已阻断");
      setMemoryUiState(ctx, "faulted");
      writeRecord("context_blocked", {
        fault: authorization.fault.kind,
        detail: authorization.fault.detail,
        messagesHash: hash(event.messages),
        ...branchSnapshot(ctx),
      });
      maybeFail("context");
      // 本扩展停止自身构造与确认；最终 transport 是否发生由职责外观测决定。
      ctx.abort();
      return undefined;
    }

    if (!requestProof) {
      contextAuthorizationOutcome = "blocked";
      setAuthorization("已阻断");
      setMemoryUiState(ctx, "faulted");
      writeRecord("context_blocked", { fault: "service", detail: "Provider payload proof construction failed" });
      ctx.abort();
      return undefined;
    }
    contextAuthorizationOutcome = "allowed";
    pendingAssemblyProof = requestProof;
    setAuthorization("增强记忆");
    setMemoryUiState(ctx, "active");
    writeRecord("context_allowed", {
      nonce: authorization.proof.nonce,
      generation: authorization.proof.generation,
      requestRouteFingerprint: authorization.proof.requestRouteFingerprint,
      historicalRouteFingerprint: authorization.proof.historicalRouteFingerprint,
      checkpointIdentity: authorization.proof.checkpointIdentity,
      retentionBudgetIdentity: authorization.proof.retentionBudgetIdentity,
      deltaHash: authorization.proof.deltaHash,
      enhancedContentHash: authorization.proof.enhancedContentHash,
      providerPayloadProfileId: authorization.proof.providerPayloadProfileId,
      currentTurn: authorization.metrics,
      messagesHash: requestProof.payload.messagesHash,
      messageCount: requestProof.payload.messageCount,
      payloadProofAdapter: requestProof.payload.adapterId,
      inputMessagesHash: hash(event.messages),
      adoptedMessagesBytes: bytes(authorization.enhancedContext),
      ...branchSnapshot(ctx),
    });
    maybeFail("context");
    return { messages: authorization.enhancedContext as never };
  });

  pi.on("before_provider_headers", (event, ctx) => {
    writeRecord("before_provider_headers", { headerNames: Object.keys(event.headers).sort(), provider: ctx.model?.provider, model: ctx.model?.id });
    maybeFail("before_provider_headers");
  });

  pi.on("before_provider_request", async (event, ctx) => {
    providerRequestIndex += 1;
    const payloadHasEnhancedContext = payloadUsesEnhancedContext(event.payload);
    const proof = pendingAssemblyProof;
    pendingAssemblyProof = undefined;
    let currentRuntimeGeneration: string | undefined;
    let currentMemoryCapabilityProofId: string | undefined;
    let runtimeValidationError: string | undefined;
    if (proof) {
      try {
        const runtimeRoot = await locateProjectRoot(ctx.cwd);
        const runtimeState = await readRuntimeState(runtimeRoot);
        currentRuntimeGeneration = memoryRuntimeGenerationFromState(runtimeState);
        currentMemoryCapabilityProofId = runtimeState?.memoryCapability?.proofId;
        if (!currentRuntimeGeneration) runtimeValidationError = "Memory runtime capability is unavailable";
      } catch (error) {
        runtimeValidationError = error instanceof Error ? error.message : String(error);
      }
    }
    let currentProviderPayloadProfile: ProviderPayloadProfile | undefined;
    let currentProviderPayloadProfileId: string | undefined;
    let providerPayloadProfileError: string | undefined;
    try {
      currentProviderPayloadProfile = providerPayloadProfile(ctx);
      currentProviderPayloadProfileId = currentProviderPayloadProfile.identity;
    } catch (error) {
      providerPayloadProfileError = error instanceof Error ? error.message : String(error);
    }

    let currentRequestRouteFingerprint: string | undefined;
    let currentHistoricalRouteFingerprint: string | undefined;
    let currentCheckpointIdentity: string | undefined;
    let currentDeltaHash: string | undefined;
    let historicalValidationError: string | undefined;
    if (proof && currentProviderPayloadProfile) {
      try {
        const liveSnapshot = sessionRouteSnapshot(ctx);
        const activeCoordinator = currentCoordinator(ctx);
        if (!liveSnapshot || !activeCoordinator) throw new Error("The current Pi route is unavailable at the Provider hook");
        const requestRoute = activeCoordinator.identifyCurrentRoute(liveSnapshot);
        currentRequestRouteFingerprint = requestRoute.fingerprint;
        const historicalSnapshot = snapshotBeforeCurrentPrompt(liveSnapshot);
        const retentionBudgetIdentity = createRetentionBudgetIdentity(
          currentProviderPayloadProfile,
          activeCoordinator.checkpointRetentionPolicy(),
        );
        if (retentionBudgetIdentity !== proof.assembly.retentionBudgetIdentity) {
          throw new Error("Checkpoint retention budget changed after the context decision");
        }
        const historical = await activeCoordinator.resolveHistoricalContext(
          historicalSnapshot,
          retentionBudgetIdentity,
          proof.assembly.checkpointIdentity,
        );
        currentHistoricalRouteFingerprint = historical.route.fingerprint;
        currentCheckpointIdentity = historical.checkpoint.identity;
        currentDeltaHash = historical.delta.hash;
      } catch (error) {
        historicalValidationError = error instanceof Error ? error.message : String(error);
      }
    }
    const routeProofError = proof
      ? assemblyRouteProofError(proof.assembly, currentRequestRouteFingerprint, currentHistoricalRouteFingerprint)
      : undefined;
    // 只核对本 handler 执行时实际可见的 payload；最终采用由职责外观测分类。
    let hookOutcome: "verified" | "rejected" | "no-constructed-output";
    let rejectionReason: string | undefined;
    if (!proof) {
      hookOutcome = "no-constructed-output";
      if (payloadHasEnhancedContext) rejectionReason = "enhanced content without a current proof";
    } else if (!payloadHasEnhancedContext) {
      hookOutcome = "rejected";
      rejectionReason = "handler payload no longer carries the constructed enhanced content";
    } else if (!payloadCarriesNonce(event.payload, proof.assembly.nonce)) {
      hookOutcome = "rejected";
      rejectionReason = "handler payload does not carry the expected nonce";
    } else if (!payloadCarriesEnhancedContent(
      event.payload,
      proof.assembly.nonce,
      proof.assembly.enhancedContentHash,
    )) {
      hookOutcome = "rejected";
      rejectionReason = "handler payload changed the constructed enhanced content";
    } else if (!currentRuntimeGeneration) {
      hookOutcome = "rejected";
      rejectionReason = runtimeValidationError ?? "memory runtime capability is unavailable";
    } else if (currentRuntimeGeneration !== proof.assembly.generation) {
      hookOutcome = "rejected";
      rejectionReason = "runtime generation changed after the context decision";
    } else if (currentMemoryCapabilityProofId !== proof.memoryCapabilityProofId) {
      hookOutcome = "rejected";
      rejectionReason = "memory capability proof changed after the context decision";
    } else if (ctx.model?.provider !== proof.payload.provider
      || ctx.model.id !== proof.payload.model
      || ctx.model.api !== proof.payload.api) {
      hookOutcome = "rejected";
      rejectionReason = "task Provider, model, or API changed after the context decision";
    } else if (currentProviderPayloadProfileId !== proof.assembly.providerPayloadProfileId) {
      hookOutcome = "rejected";
      rejectionReason = providerPayloadProfileError
        ? `Provider payload profile is unavailable: ${providerPayloadProfileError}`
        : "Provider payload profile changed after the context decision";
    } else if (historicalValidationError) {
      hookOutcome = "rejected";
      rejectionReason = historicalValidationError;
    } else if (routeProofError) {
      hookOutcome = "rejected";
      rejectionReason = routeProofError;
    } else if (currentCheckpointIdentity !== proof.assembly.checkpointIdentity) {
      hookOutcome = "rejected";
      rejectionReason = "MemoryCheckpoint changed after the context decision";
    } else if (currentDeltaHash !== proof.assembly.deltaHash) {
      hookOutcome = "rejected";
      rejectionReason = "VerifiedActiveDelta changed after the context decision";
    } else if (!openAICompletionsPayloadMatchesProfile(event.payload, {
      systemPromptHash: currentProviderPayloadProfile!.systemPromptHash,
      toolsHash: currentProviderPayloadProfile!.toolsHash,
      maxOutputTokens: currentProviderPayloadProfile!.maxOutputTokens,
    })) {
      hookOutcome = "rejected";
      rejectionReason = "handler payload does not match the constructed Provider payload profile";
    } else if (!openAICompletionsPayloadMatches(event.payload, proof.assembly.nonce, proof.payload)) {
      hookOutcome = "rejected";
      rejectionReason = "handler payload changed the constructed Provider message sequence";
    } else {
      hookOutcome = "verified";
    }

    if (hookOutcome === "verified") {
      setAuthorization("增强记忆");
      setMemoryUiState(ctx, "active");
    } else if (hookOutcome === "rejected") {
      latchGenerationFault(
        ctx,
        "provider-proof",
        { kind: "service", detail: rejectionReason ?? "Provider proof rejected" },
        { generation: proof?.assembly.generation, sessionScoped: true },
      );
      setAuthorization("已阻断");
      setMemoryUiState(ctx, "faulted");
    }

    writeRecord("before_provider_request", {
      requestIndex: providerRequestIndex,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      // hook 时点事实，不表示最终 Provider 采用
      hookOutcome,
      rejectionReason,
      nonce: proof?.assembly.nonce,
      memoryCapabilityProofId: proof?.memoryCapabilityProofId,
      currentMemoryCapabilityProofId,
      providerPayloadProfileId: proof?.assembly.providerPayloadProfileId,
      currentProviderPayloadProfileId,
      checkpointIdentity: proof?.assembly.checkpointIdentity,
      currentCheckpointIdentity,
      deltaHash: proof?.assembly.deltaHash,
      currentDeltaHash,
      requestRouteFingerprint: proof?.assembly.requestRouteFingerprint,
      currentRequestRouteFingerprint,
      historicalRouteFingerprint: proof?.assembly.historicalRouteFingerprint,
      currentHistoricalRouteFingerprint,
      contextAuthorization: contextAuthorizationOutcome,
      payloadHasEnhancedContext,
      ...payloadSummary(event.payload),
      ...branchSnapshot(ctx),
    });
    maybeFail("before_provider_request");
    if (hookOutcome === "rejected") ctx.abort();
  });

  pi.on("after_provider_response", (event, ctx) => {
    writeRecord("after_provider_response", {
      requestIndex: providerRequestIndex,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      status: event.status,
      requestId: event.headers["x-request-id"] ?? event.headers["request-id"],
    });
    maybeFail("after_provider_response");
  });

  pi.on("message_end", (event, ctx) => {
    writeRecord("message_end", { message: messageSummary(event.message), ...branchSnapshot(ctx) });
    maybeFail("message_end");
  });

  pi.on("tool_call", (event, ctx) => {
    writeRecord("tool_call", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputBytes: bytes(event.input),
      inputHash: hash(event.input),
      ...branchSnapshot(ctx),
    });
    maybeFail("tool_call");
  });

  pi.on("tool_result", (event, ctx) => {
    writeRecord("tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      content: contentSummary(event.content),
      detailsBytes: bytes(event.details),
      usage: event.usage,
      ...branchSnapshot(ctx),
    });
    maybeFail("tool_result");
  });

  pi.on("turn_end", (event, ctx) => {
    writeRecord("turn_end", {
      turnIndex: event.turnIndex,
      message: messageSummary(event.message),
      toolResults: event.toolResults.map((result) => ({ toolName: result.toolName, isError: result.isError })),
      ...branchSnapshot(ctx),
    });
    maybeFail("turn_end");
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    scheduleArchive(ctx, "turn_end");
  });

  pi.on("agent_end", (event, ctx) => {
    writeRecord("agent_end", { messages: event.messages.map((message) => messageSummary(message)), ...branchSnapshot(ctx) });
    maybeFail("agent_end");
  });

  pi.on("agent_settled", (_event, ctx) => {
    writeRecord("agent_settled", branchSnapshot(ctx));
    maybeFail("agent_settled");
    const settledSnapshot = sessionRouteSnapshot(ctx);
    scheduleArchive(ctx, "agent_settled");
    scheduleCheckpointRefresh(ctx, settledSnapshot, "agent_settled");
  });

  pi.on("session_before_compact", (event, ctx) => {
    pendingCompactionDecision = { reason: event.reason, branchLeafId: ctx.sessionManager.getLeafId() };
    writeRecord("session_before_compact", {
      reason: event.reason,
      decision: "cancel",
      willRetry: event.willRetry,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      branchEntryIds: event.branchEntries.map((entry) => entry.id),
      ...branchSnapshot(ctx),
    });
    maybeFail("session_before_compact");
    return { cancel: true };
  });

  pi.on("session_compact", (event, ctx) => {
    writeRecord("host_behavior_unverified", {
      boundary: "compaction",
      requestedDecision: pendingCompactionDecision ? "cancel" : "unobserved",
      requestedReason: pendingCompactionDecision?.reason,
      actualReason: event.reason,
      actualEntryId: event.compactionEntry.id,
    });
    pendingCompactionDecision = undefined;
    if (ctx.hasUI) ctx.ui.notify("增强记忆请求取消 Pi compaction，但宿主仍生成了 compaction entry。", "warning");
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    setAuthorization("初始化中");
    writeRecord("session_compact", {
      reason: event.reason,
      willRetry: event.willRetry,
      compactionEntryId: event.compactionEntry.id,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      fromExtension: event.fromExtension,
      ...branchSnapshot(ctx),
    });
    maybeFail("session_compact");
    scheduleArchive(ctx, "session_compact");
    scheduleCheckpointRefresh(ctx, sessionRouteSnapshot(ctx), "session_compact");
  });

  pi.on("session_before_tree", (event, ctx) => {
    const decision = event.preparation.userWantsSummary ? "empty-summary" : "unchanged";
    pendingTreeDecision = {
      targetId: event.preparation.targetId,
      oldLeafId: event.preparation.oldLeafId,
      userWantsSummary: event.preparation.userWantsSummary,
      decision,
    };
    writeRecord("session_before_tree", {
      targetId: event.preparation.targetId,
      oldLeafId: event.preparation.oldLeafId,
      commonAncestorId: event.preparation.commonAncestorId,
      userWantsSummary: event.preparation.userWantsSummary,
      decision,
      summarizedEntryIds: event.preparation.entriesToSummarize.map((entry) => entry.id),
      ...branchSnapshot(ctx),
    });
    maybeFail("session_before_tree");
    if (decision === "empty-summary") return { summary: { summary: "" } };
  });

  pi.on("session_tree", (event, ctx) => {
    const treeDecision = pendingTreeDecision;
    const summarySuppressionViolated = treeDecision?.decision === "empty-summary" && event.summaryEntry !== undefined;
    if (summarySuppressionViolated) {
      writeRecord("host_behavior_unverified", {
        boundary: "tree-summary",
        requestedDecision: treeDecision.decision,
        targetId: treeDecision.targetId,
        actualSummaryEntryId: event.summaryEntry?.id,
        actualFromExtension: event.fromExtension,
      });
      if (ctx.hasUI) ctx.ui.notify("增强记忆请求无摘要 tree 导航，但宿主仍生成了 branch summary。", "warning");
    }
    pendingTreeDecision = undefined;
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    setAuthorization("初始化中");
    writeRecord("session_tree", {
      newLeafId: event.newLeafId,
      oldLeafId: event.oldLeafId,
      summaryEntryId: event.summaryEntry?.id,
      fromExtension: event.fromExtension,
      requestedDecision: treeDecision?.decision,
      hostBehavior: summarySuppressionViolated ? "unverified" : "observed",
      ...branchSnapshot(ctx),
    });
    maybeFail("session_tree");
    scheduleArchive(ctx, "session_tree");
    scheduleCheckpointRefresh(ctx, sessionRouteSnapshot(ctx), "session_tree");
  });

  pi.on("model_select", (event, ctx) => {
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("task model changed");
    setAuthorization("初始化中");
    writeRecord("model_select", {
      source: event.source,
      previousModel: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : undefined,
      model: `${event.model.provider}/${event.model.id}`,
      ...branchSnapshot(ctx),
    });
    maybeFail("model_select");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    contextAuthorizationOutcome = "pending";
    retireUnobservedProof("lifecycle reset");
    setAuthorization("初始化中");
    if (ctx.hasUI) ctx.ui.setStatus("pi-context-memory", undefined);
    if (footerInstalled && ctx.mode === "tui") {
      ctx.ui.setFooter(undefined);
      footerInstalled = false;
      writeRecord("footer_adapter", { action: "uninstalled", mode: ctx.mode });
    }
    pendingCompactionDecision = undefined;
    pendingTreeDecision = undefined;
    writeRecord("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile, ...branchSnapshot(ctx) });
    maybeFail("session_shutdown");
    scheduleArchive(ctx, "session_shutdown");
    shuttingDown = true;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        waitForArchiveIdle(),
        new Promise<void>((resolveTimeout) => {
          timeout = setTimeout(resolveTimeout, 5_000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      stopArchiveQueue();
      sourceIndexes.shutdown();
      closeMemoryModelWatchers();
      memoryEnhancementAvailable = false;
      await transitionWorkingContext();
    }
  });
}
