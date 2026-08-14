import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FileLongTermMemory, type SessionIdentity, type SourceEntry } from "./long-term-memory.ts";
import {
  expandSource,
  formatSearchResult,
  OpenVikingSourceRecall,
} from "./recall-and-provenance.ts";
import {
  SessionMemoryCoordinator,
  SessionSourceIndexCoordinator,
  type SessionRouteIdentity,
  type SessionRouteSnapshot,
} from "./session-memory-coordination.ts";
import {
  applyPreparedWorkingContext,
  WorkingContextOptimizer,
} from "./working-context-optimization.ts";
import {
  memoryModelConfigPath,
  locateProjectRoot,
  memoryModelSettingsFingerprint,
  memoryModelConfigContentFingerprint,
  validateMemoryModelConfiguration,
  validateMemoryModelSetting,
  readRuntimeState,
  requestOpenVikingRestart,
  type MemoryModelSetting,
  type ValidatedMemoryModelConfiguration,
  type OpenVikingRuntimeState,
} from "./memory-model-configuration.ts";

const SCHEMA_VERSION = 1;
const observationPath = process.env.PCR_OBSERVATION_LOG
  ? resolve(process.cwd(), process.env.PCR_OBSERVATION_LOG)
  : undefined;
const runId = process.env.PCR_RUN_ID ?? "manual";
const failureEvent = process.env.PCR_PROBE_FAIL_EVENT;
const archiveDelayMs = Number.parseInt(process.env.PCR_ARCHIVE_DELAY_MS ?? "0", 10) || 0;
const archiveCopyTimeoutMs = (() => {
  const configured = process.env.PCR_ARCHIVE_COPY_TIMEOUT_MS;
  if (configured === undefined) return 5_000;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PCR_ARCHIVE_COPY_TIMEOUT_MS must be a positive integer");
  }
  return value;
})();
const openVikingUrl = process.env.PCR_OPENVIKING_URL ?? "http://127.0.0.1:1933";
const openVikingApiKey = process.env.PCR_OPENVIKING_API_KEY;
const openVikingTimeoutMs = Number.parseInt(process.env.PCR_OPENVIKING_TIMEOUT_MS ?? "30000", 10) || 30_000;
const recallParameters = Type.Object({
  action: StringEnum(["search", "read_source"] as const, {
    description: "search for current-session sources or expand one current-branch source",
  }),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
  entry_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  max_chars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 20_000 })),
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
  let currentPromptIndex = -1;
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (
      entry.type === "message"
      && entry.message
      && typeof entry.message === "object"
      && (entry.message as Record<string, unknown>).role === "user"
    ) {
      currentPromptIndex = index;
      break;
    }
  }
  if (currentPromptIndex < 0) return snapshot;
  const entries = snapshot.entries.slice(0, currentPromptIndex);
  return { ...snapshot, entries, leafId: entries.at(-1)?.id ?? null };
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
function payloadUsesEnhancedContext(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes("# Enhanced session context");
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => payloadUsesEnhancedContext(item, seen));
  return Object.values(value as Record<string, unknown>).some((item) => payloadUsesEnhancedContext(item, seen));
}

function updateContextPathStatus(ctx: ExtensionContext, path: "Pi 原生" | "增强记忆" = "Pi 原生"): void {
  if (ctx.hasUI) ctx.ui.setStatus("pi-context-memory", path);
}

function formatMemoryModelState(
  configPath: string,
  setting: MemoryModelSetting | undefined,
  state: OpenVikingRuntimeState | undefined,
  contextPath: "Pi 原生" | "增强记忆",
): string {
  const configured = setting ? `${setting.provider}/${setting.model}` : "not configured";
  const running = state?.activeProvider && state.activeModel ? `${state.activeProvider}/${state.activeModel}` : "no VLM loaded";
  const applied = Boolean(state?.ready && (setting
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
    `Service readiness: ${state?.ready ? "ready" : state?.phase ?? "launcher unavailable"}`,
    `Configuration: ${configurationStatus}`,
    state?.configurationError ? `Last cold-start configuration error: ${state.configurationError}` : undefined,
    `Context path: ${contextPath}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}


export default function piContextMemoryProbe(pi: ExtensionAPI): void {
  let sourceRecall: OpenVikingSourceRecall | undefined;
  try {
    sourceRecall = new OpenVikingSourceRecall(openVikingUrl, openVikingApiKey, openVikingTimeoutMs);
  } catch (error) {
    writeRecord("source_index_config_error", { error: error instanceof Error ? error.message : String(error) });
  }
  let workingContextOptimizer: WorkingContextOptimizer | undefined;
  let workingContextGeneration: string | undefined;
  let workingContextTransition: Promise<void> = Promise.resolve();
  let workingContextProjectRoot: string | undefined;
  let workingContextConfigContentFingerprint: string | undefined;
  let coordinator: SessionMemoryCoordinator | undefined;
  let coordinatorIdentity: string | undefined;
  let archiveUnavailable = false;
  let failureNotified = false;
  let archiveRunning = false;
  let sourceIndexUnavailable = sourceRecall === undefined;
  let sourceIndexFailureNotified = false;
  const archiveQueue: Array<{
    key: string;
    coordinator: SessionMemoryCoordinator;
    snapshot: SessionRouteSnapshot;
    trigger: string;
  }> = [];
  const archiveIdleWaiters = new Set<() => void>();
  const queuedArchives = new Set<string>();
  let lastMemoryModelConfigDiagnosticKey: string | undefined;
  let memoryModelConfigCheck: Promise<void> | undefined;
  let memoryEnhancementAvailable = false;
  let lastContextPath: "Pi 原生" | "增强记忆" = "Pi 原生";
  let providerContextDecision: "pi-native" | "enhanced" = "pi-native";
  function transitionWorkingContext(nextGeneration?: string): Promise<boolean> {
    const transition = async (): Promise<boolean> => {
      if (nextGeneration && workingContextOptimizer && workingContextGeneration === nextGeneration) return true;
      const previous = workingContextOptimizer;
      workingContextOptimizer = undefined;
      workingContextGeneration = undefined;
      if (previous) await previous.shutdown(new Error("Working context runtime generation changed"));
      if (!nextGeneration) return false;
      try {
        workingContextOptimizer = new WorkingContextOptimizer(openVikingUrl, openVikingApiKey, openVikingTimeoutMs);
        workingContextGeneration = nextGeneration;
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

  function runtimeWorkingContextGeneration(state: OpenVikingRuntimeState | undefined): string | undefined {
    if (!state?.ready || state.configurationError) return undefined;
    if (!state.activeProvider || state.activeProvider !== state.targetProvider) return undefined;
    if (!state.activeModel || state.activeModel !== state.targetModel) return undefined;
    if (!state.activeSettingsFingerprint || state.activeSettingsFingerprint !== state.targetSettingsFingerprint) return undefined;
    if (!state.activeConfigFingerprint || state.activeConfigFingerprint !== state.targetConfigFingerprint) return undefined;
    return `${state.activeSettingsFingerprint}\0${state.activeConfigFingerprint}`;
  }

  function activeWorkingContextGeneration(
    validated: ValidatedMemoryModelConfiguration | undefined,
    state: OpenVikingRuntimeState | undefined,
  ): string | undefined {
    if (!validated) return undefined;
    const { setting, compiled } = validated;
    const expected = `${memoryModelSettingsFingerprint(setting)}\0${compiled.configFingerprint}`;
    return state?.activeProvider === setting.provider
      && state.activeModel === setting.model
      && runtimeWorkingContextGeneration(state) === expected
      ? expected
      : undefined;
  }
  async function workingContextGenerationIsCurrent(ctx: ExtensionContext): Promise<boolean> {
    if (!workingContextGeneration || !workingContextProjectRoot || !workingContextConfigContentFingerprint) return false;
    try {
      const root = await locateProjectRoot(ctx.cwd);
      if (root !== workingContextProjectRoot) return false;
      const [state, contentFingerprint] = await Promise.all([
        readRuntimeState(root),
        memoryModelConfigContentFingerprint(root),
      ]);
      return runtimeWorkingContextGeneration(state) === workingContextGeneration
        && contentFingerprint === workingContextConfigContentFingerprint;
    } catch {
      return false;
    }
  }

  function setContextPath(ctx: ExtensionContext, path: "Pi 原生" | "增强记忆"): void {
    lastContextPath = path;
    updateContextPathStatus(ctx, path);
  }

  async function reportMemoryModelConfigError(ctx: ExtensionContext): Promise<void> {
    let root: string | undefined;
    let validated: ValidatedMemoryModelConfiguration | undefined;
    let state: OpenVikingRuntimeState | undefined;
    let contentFingerprint: string | undefined;
    try {
      root = await locateProjectRoot(ctx.cwd);
      validated = await validateMemoryModelConfiguration(root);
      state = await readRuntimeState(root);
      contentFingerprint = await memoryModelConfigContentFingerprint(root);
      lastMemoryModelConfigDiagnosticKey = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const contentFingerprint = root ? await memoryModelConfigContentFingerprint(root) : undefined;
      const diagnosticKey = `${contentFingerprint ?? "unreadable"}:${hash(message)}`;
      if (diagnosticKey !== lastMemoryModelConfigDiagnosticKey) {
        lastMemoryModelConfigDiagnosticKey = diagnosticKey;
        writeRecord("memory_model_config_error", { error: message, contentFingerprint });
        if (ctx.hasUI) ctx.ui.notify(`${message}\nPi will continue with its native context.`, "warning");
      }
    }
    const generation = activeWorkingContextGeneration(validated, state);
    const generationReady = await transitionWorkingContext(generation);
    memoryEnhancementAvailable = Boolean(generation && generationReady && root && contentFingerprint);
    workingContextProjectRoot = memoryEnhancementAvailable ? root : undefined;
    workingContextConfigContentFingerprint = memoryEnhancementAvailable ? contentFingerprint : undefined;
    if (memoryEnhancementAvailable) scheduleWorkingContext(ctx, sessionRouteSnapshot(ctx), "runtime_ready");
  }

  function scheduleMemoryModelConfigCheck(ctx: ExtensionContext): void {
    if (memoryModelConfigCheck) return;
    memoryModelConfigCheck = reportMemoryModelConfigError(ctx).catch(() => undefined).finally(() => {
      memoryModelConfigCheck = undefined;
    });
  }

  function currentCoordinator(ctx: ExtensionContext): SessionMemoryCoordinator | undefined {
    const identity = sessionIdentity(ctx);
    if (!identity) return undefined;
    const key = `${identity.sessionId}\0${identity.sessionFile}`;
    if (!coordinator || coordinatorIdentity !== key) {
      coordinator = new SessionMemoryCoordinator(identity, new FileLongTermMemory(archiveRoot(ctx), archiveCopyTimeoutMs));
      coordinatorIdentity = key;
    }
    return coordinator;
  }
  function scheduleWorkingContext(
    ctx: ExtensionContext,
    snapshot: SessionRouteSnapshot | undefined,
    trigger: string,
  ): void {
    if (!memoryEnhancementAvailable || !workingContextOptimizer || !snapshot || snapshot.entries.length === 0) return;
    const activeCoordinator = currentCoordinator(ctx);
    if (!activeCoordinator) return;
    let route: SessionRouteIdentity;
    try {
      route = activeCoordinator.identifyCurrentRoute(snapshot);
    } catch (error) {
      writeRecord("working_context_rejected", {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void workingContextOptimizer.prepare(route, snapshot.entries).then(
      (prepared) => writeRecord("working_context_ready", {
        trigger,
        sessionId: route.sessionId,
        leafId: route.leafId,
        routeFingerprint: route.fingerprint,
        openVikingSessionId: prepared.openVikingSessionId,
        estimatedTokens: prepared.estimatedTokens,
        hasWorkingMemory: prepared.hasWorkingMemory,
        contentHash: hash(prepared.content),
      }),
      (error) => writeRecord("working_context_error", {
        trigger,
        sessionId: route.sessionId,
        leafId: route.leafId,
        routeFingerprint: route.fingerprint,
        error: error instanceof Error ? error.message : String(error),
      }),
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
  ): Promise<void> {
    try {
      if (archiveDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, archiveDelayMs));
      if (!await hasAuthoritativeSessionFile(snapshot)) {
        writeRecord("archive_skipped", { trigger, sessionId: snapshot.sessionId, reason: "session_not_persisted" });
        return;
      }
      const result = await activeCoordinator.archiveCurrentRoute(snapshot);
      archiveUnavailable = false;
      failureNotified = false;
      writeRecord("archive_complete", {
        trigger,
        sessionId: snapshot.sessionId,
        leafId: snapshot.leafId,
        sourceCount: snapshot.entries.length,
        largeResults: result.archivedToolCallIds.length,
      });
      sourceIndexes.scheduleBackground(activeCoordinator, snapshot, trigger);
    } catch (error) {
      archiveUnavailable = true;
      const message = error instanceof Error ? error.message : String(error);
      writeRecord("archive_error", { trigger, sessionId: snapshot.sessionId, error: message });
    }
  }

  function pumpArchiveQueue(): void {
    if (archiveRunning) return;
    const job = archiveQueue.shift();
    if (!job) {
      for (const resolveIdle of archiveIdleWaiters) resolveIdle();
      archiveIdleWaiters.clear();
      return;
    }
    archiveRunning = true;
    void runArchive(job.coordinator, job.snapshot, job.trigger).finally(() => {
      queuedArchives.delete(job.key);
      archiveRunning = false;
      pumpArchiveQueue();
    });
  }

  function waitForArchiveIdle(): Promise<void> {
    if (!archiveRunning && archiveQueue.length === 0) return Promise.resolve();
    return new Promise((resolveIdle) => archiveIdleWaiters.add(resolveIdle));
  }

  function scheduleArchive(ctx: ExtensionContext, trigger: string): void {
    if (archiveUnavailable && !failureNotified && ctx.hasUI) {
      ctx.ui.notify("Source archiving is unavailable; Pi will continue normally.", "warning");
      failureNotified = true;
    }
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
    archiveQueue.push({ key, coordinator: activeCoordinator, snapshot, trigger });
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
        ctx.ui.notify(formatMemoryModelState(configPath, setting, state, lastContextPath), "info");
        updateContextPathStatus(ctx, lastContextPath);
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
      try {
        root = await locateProjectRoot(ctx.cwd);
        memoryEnhancementAvailable = false;
        workingContextProjectRoot = undefined;
        workingContextConfigContentFingerprint = undefined;
        providerContextDecision = "pi-native";
        setContextPath(ctx, "Pi 原生");
        if (memoryModelConfigCheck) await memoryModelConfigCheck;
        memoryEnhancementAvailable = false;
        workingContextProjectRoot = undefined;
        workingContextConfigContentFingerprint = undefined;
        await transitionWorkingContext();
        if (ctx.hasUI) ctx.ui.setStatus("pi-context-memory", "Pi 原生 · OpenViking applying");
        const state = await requestOpenVikingRestart(root);
        const validated = await validateMemoryModelConfiguration(root);
        const generation = activeWorkingContextGeneration(validated, state);
        const contentFingerprint = await memoryModelConfigContentFingerprint(root);
        const generationReady = await transitionWorkingContext(generation);
        memoryEnhancementAvailable = Boolean(generation && generationReady && contentFingerprint);
        workingContextProjectRoot = memoryEnhancementAvailable ? root : undefined;
        workingContextConfigContentFingerprint = memoryEnhancementAvailable ? contentFingerprint : undefined;
        if (memoryEnhancementAvailable) scheduleWorkingContext(ctx, sessionRouteSnapshot(ctx), "restart");
        writeRecord("openviking_restart_complete", {
          provider: state.activeProvider,
          model: state.activeModel,
          configFingerprint: state.activeConfigFingerprint,
        });
        ctx.ui.notify(`OpenViking ready: ${state.activeProvider ?? "no VLM"}/${state.activeModel ?? "source recall only"}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        memoryEnhancementAvailable = false;
        workingContextProjectRoot = undefined;
        workingContextConfigContentFingerprint = undefined;
        await transitionWorkingContext();
        if (root && message.startsWith("Invalid memory model configuration at ")) {
          const contentFingerprint = await memoryModelConfigContentFingerprint(root);
          lastMemoryModelConfigDiagnosticKey = `${contentFingerprint ?? "unreadable"}:${hash(message)}`;
        }
        writeRecord("openviking_restart_error", { error: message });
        ctx.ui.notify(message, "error");
      } finally {
        providerContextDecision = "pi-native";
        setContextPath(ctx, "Pi 原生");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    providerContextDecision = "pi-native";
    setContextPath(ctx, "Pi 原生");
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
        const expansion = expandSource(resolved.authoritativeEntry, params.max_chars ?? 8_000);
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
          params.limit ?? 5,
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
    },
  });
  pi.on("session_start", (event, ctx) => {
    writeRecord("session_start", { reason: event.reason, previousSessionFile: event.previousSessionFile, mode: ctx.mode, ...branchSnapshot(ctx) });
    maybeFail("session_start");
    scheduleArchive(ctx, "session_start");
  });

  pi.on("input", (event, ctx) => {
    writeRecord("input", { source: event.source, textBytes: Buffer.byteLength(event.text, "utf8"), images: event.images?.length ?? 0, ...branchSnapshot(ctx) });
    maybeFail("input");
  });

  pi.on("before_agent_start", (event, ctx) => {
    providerContextDecision = "pi-native";
    setContextPath(ctx, "Pi 原生");
    if (!memoryEnhancementAvailable) scheduleMemoryModelConfigCheck(ctx);
    const workingSnapshot = sessionRouteSnapshot(ctx);
    scheduleWorkingContext(ctx, workingSnapshot ? snapshotBeforeCurrentPrompt(workingSnapshot) : undefined, "before_agent_start");
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
    if (memoryModelConfigCheck) await memoryModelConfigCheck;
    let adoptedMessages = event.messages;
    let routeFingerprint: string | undefined;
    let preparedContextHash: string | undefined;
    const generationCurrent = memoryEnhancementAvailable && workingContextOptimizer
      ? await workingContextGenerationIsCurrent(ctx)
      : false;
    if (memoryEnhancementAvailable && !generationCurrent) {
      memoryEnhancementAvailable = false;
      workingContextProjectRoot = undefined;
      workingContextConfigContentFingerprint = undefined;
      void transitionWorkingContext();
      scheduleMemoryModelConfigCheck(ctx);
    }
    if (generationCurrent && workingContextOptimizer) {
      const snapshot = sessionRouteSnapshot(ctx);
      const activeCoordinator = currentCoordinator(ctx);
      if (snapshot && activeCoordinator) {
        try {
          const historicalSnapshot = snapshotBeforeCurrentPrompt(snapshot);
          const route = activeCoordinator.identifyCurrentRoute(historicalSnapshot);
          routeFingerprint = route.fingerprint;
          const prepared = workingContextOptimizer.getReady(route);
          if (prepared) {
            adoptedMessages = applyPreparedWorkingContext(event.messages, prepared);
            preparedContextHash = hash(prepared.content);
          }
        } catch (error) {
          writeRecord("working_context_rejected", {
            trigger: "context",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const firstAdoptedMessage = adoptedMessages[0] as unknown;
    const adopted = Boolean(
      firstAdoptedMessage
      && typeof firstAdoptedMessage === "object"
      && (firstAdoptedMessage as Record<string, unknown>).role === "custom"
      && (firstAdoptedMessage as Record<string, unknown>).customType === "pi-context-memory",
    );
    providerContextDecision = adopted ? "enhanced" : "pi-native";
    setContextPath(ctx, adopted ? "增强记忆" : "Pi 原生");
    writeRecord("context", {
      messages: event.messages.map((message) => messageSummary(message)),
      messagesHash: hash(event.messages),
      messagesBytes: bytes(event.messages),
      adoptedMessagesHash: adopted ? hash(adoptedMessages) : undefined,
      adoptedMessagesBytes: adopted ? bytes(adoptedMessages) : undefined,
      contextPath: adopted ? "enhanced" : "pi-native",
      routeFingerprint,
      preparedContextHash,
      ...branchSnapshot(ctx),
    });
    maybeFail("context");
    return adopted ? { messages: adoptedMessages } : undefined;
  });

  pi.on("before_provider_headers", (event, ctx) => {
    writeRecord("before_provider_headers", { headerNames: Object.keys(event.headers).sort(), provider: ctx.model?.provider, model: ctx.model?.id });
    maybeFail("before_provider_headers");
  });

  pi.on("before_provider_request", (event, ctx) => {
    providerRequestIndex += 1;
    const payloadHasEnhancedContext = payloadUsesEnhancedContext(event.payload);
    const enhanced = providerContextDecision === "enhanced" && payloadHasEnhancedContext;
    setContextPath(ctx, enhanced ? "增强记忆" : "Pi 原生");
    writeRecord("before_provider_request", {
      requestIndex: providerRequestIndex,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      contextPath: enhanced ? "enhanced" : "pi-native",
      contextDecision: providerContextDecision,
      payloadHasEnhancedContext,
      contextDecisionMismatch: payloadHasEnhancedContext !== (providerContextDecision === "enhanced"),
      ...payloadSummary(event.payload),
      ...branchSnapshot(ctx),
    });
    maybeFail("before_provider_request");
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
    scheduleArchive(ctx, "turn_end");
    scheduleWorkingContext(ctx, sessionRouteSnapshot(ctx), "turn_end");
  });

  pi.on("agent_end", (event, ctx) => {
    writeRecord("agent_end", { messages: event.messages.map((message) => messageSummary(message)), ...branchSnapshot(ctx) });
    maybeFail("agent_end");
  });

  pi.on("agent_settled", (_event, ctx) => {
    writeRecord("agent_settled", branchSnapshot(ctx));
    maybeFail("agent_settled");
  });

  pi.on("session_tree", (event, ctx) => {
    writeRecord("session_tree", {
      newLeafId: event.newLeafId,
      oldLeafId: event.oldLeafId,
      summaryEntryId: event.summaryEntry?.id,
      fromExtension: event.fromExtension,
      ...branchSnapshot(ctx),
    });
    maybeFail("session_tree");
    scheduleArchive(ctx, "session_tree");
    scheduleWorkingContext(ctx, sessionRouteSnapshot(ctx), "session_tree");
  });

  pi.on("model_select", (event, ctx) => {
    writeRecord("model_select", {
      source: event.source,
      previousModel: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : undefined,
      model: `${event.model.provider}/${event.model.id}`,
      ...branchSnapshot(ctx),
    });
    maybeFail("model_select");
  });

  pi.on("session_shutdown", async (event, ctx) => {
    writeRecord("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile, ...branchSnapshot(ctx) });
    maybeFail("session_shutdown");
    scheduleArchive(ctx, "session_shutdown");
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
      sourceIndexes.shutdown();
      memoryEnhancementAvailable = false;
      await transitionWorkingContext();
    }
  });
}
