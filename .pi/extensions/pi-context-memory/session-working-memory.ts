import { createHash, randomUUID } from "node:crypto";

import { taskText } from "./recall-and-provenance.ts";
import {
  DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
  OpenVikingHttpClient,
  normalizeBatchPendingTokens,
  normalizeCommitResult,
  normalizeSessionContext,
  normalizeTaskState,
  type NormalizedOpenVikingMessage,
} from "./openviking-protocol.ts";
import {
  isControlBoundary,
  isMessageSource,
  isOpaqueProviderSegment,
  type MemoryProjection,
  type MessageSource,
} from "./pi-session-protocol.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";

const DEFAULT_CONTEXT_TOKEN_BUDGET = 12_000;
const DEFAULT_COMMIT_PENDING_TOKENS = 6_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_MIRRORS = 8;
const DEFAULT_MAX_CHECKPOINTS = 16;
const DEFAULT_MAX_PENDING_REFRESHES = 16;
export const MAX_OPENVIKING_PROJECTION_BYTES = 32 * 1024;
export const MAX_OPENVIKING_APPEND_BODY_BYTES = 256 * 1024;
const MAX_OPENVIKING_APPEND_MESSAGES = 100;
export const DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS = 180_000;
const DEFAULT_TASK_POLL_MS = 100;

export interface SessionWorkingMemoryOptions {
  generation: string;
  capabilityProofId: string;
  contextTokenBudget?: number;
  commitPendingTokens?: number;
  keepRecentMessages?: number;
  maxMirrors?: number;
  maxCheckpoints?: number;
  maxPendingRefreshes?: number;
  taskTimeoutMs?: number;
  taskPollMs?: number;
}

export interface RetentionPolicy {
  version: "openviking-session-retention-v1";
  contextTokenBudget: number;
  keepRecentMessages: number;
}

export interface OpenVikingProjection {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  turn_id: string;
  message_kind: "user_query" | "assistant_step" | "tool_transport" | "checkpoint";
  source_message_ids: string[];
}

export interface RefreshTarget {
  generation: string;
  routePrefixKey: string;
  watermark: string | null;
  retentionBudgetIdentity: string;
}

export interface MemoryCheckpoint {
  identity: string;
  generation: string;
  coveredRoutePrefixKey: string;
  coveredRouteEntryIds: readonly string[];
  coveredThroughEntryId: string | null;
  retentionBudgetIdentity: string;
  sourceIds: readonly string[];
  workingMemory: string;
  activeHistory: readonly NormalizedOpenVikingMessage[];
  assemblyHash: string;
  producedUnderCapabilityProofId: string;
  openVikingSessionId: string | null;
}

export type CheckpointRefreshResult =
  | { kind: "accepted"; checkpoint: MemoryCheckpoint }
  | { kind: "skipped" }
  | { kind: "superseded" };

interface RouteMirror {
  sessionId: string;
  sessionFile: string;
  openVikingSessionId: string;
  projections: readonly OpenVikingProjection[];
  pendingTokens: number;
  retired: boolean;
  touched: number;
}

interface RefreshJob {
  key: string;
  target: RefreshTarget;
  route: SessionRouteIdentity;
  projections: readonly MemoryProjection[];
  required: boolean;
  started: boolean;
  promise: Promise<CheckpointRefreshResult>;
  resolve: (result: CheckpointRefreshResult) => void;
  reject: (error: unknown) => void;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}
function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const lastCodeUnit = value.charCodeAt(low - 1);
  if (low > 0 && lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) low -= 1;
  return value.slice(0, low);
}

function boundedProjectionContent(source: MessageSource, text: string): string {
  const prefix = `[Pi entry ${source.id}]\n`;
  const complete = `${prefix}${text}`;
  if (Buffer.byteLength(complete, "utf8") <= MAX_OPENVIKING_PROJECTION_BYTES) return complete;
  const suffix = [
    "",
    `[OpenViking projection bounded; originalBytes=${Buffer.byteLength(text, "utf8")}; taskContentHash=${source.taskContentHash}]`,
    `[Recover the exact Pi source with recall_session read_source entryId=${source.id}]`,
  ].join("\n");
  const available = MAX_OPENVIKING_PROJECTION_BYTES - Buffer.byteLength(prefix + suffix, "utf8");
  if (available <= 0) throw new Error(`Pi source identity exceeds the OpenViking projection limit: ${source.id}`);
  const content = `${prefix}${utf8Prefix(text, available)}${suffix}`;
  if (Buffer.byteLength(content, "utf8") > MAX_OPENVIKING_PROJECTION_BYTES) {
    throw new Error(`OpenViking projection exceeds its byte limit: ${source.id}`);
  }
  return content;
}

function appendBatches(projections: readonly OpenVikingProjection[]): OpenVikingProjection[][] {
  const batches: OpenVikingProjection[][] = [];
  let batch: OpenVikingProjection[] = [];
  for (const projection of projections) {
    const candidate = [...batch, projection];
    if (candidate.length > MAX_OPENVIKING_APPEND_MESSAGES
      || Buffer.byteLength(JSON.stringify({ messages: candidate }), "utf8") > MAX_OPENVIKING_APPEND_BODY_BYTES) {
      if (batch.length === 0) throw new Error("One OpenViking projection exceeds the append body limit");
      batches.push(batch);
      batch = [projection];
      if (Buffer.byteLength(JSON.stringify({ messages: batch }), "utf8") > MAX_OPENVIKING_APPEND_BODY_BYTES) {
        throw new Error("One OpenViking projection exceeds the append body limit");
      }
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** OpenViking 只接收可追溯的公开任务内容；ControlBoundary 只改变 turn 身份。 */
export function projectMemorySources(projections: readonly MemoryProjection[]): OpenVikingProjection[] {
  const result: OpenVikingProjection[] = [];
  let turnId = "route-start";
  for (const projection of projections) {
    if (isControlBoundary(projection)) {
      turnId = projection.id;
      continue;
    }
    if (!isMessageSource(projection)) continue;
    const text = taskText(projection);
    if (!text) continue;
    if (projection.role === "user") turnId = projection.id;
    result.push({
      role: projection.role === "assistant" ? "assistant" : "user",
      content: boundedProjectionContent(projection, text),
      created_at: projection.timestamp,
      turn_id: turnId,
      message_kind: messageKindOf(projection),
      source_message_ids: [projection.id],
    });
  }
  return result;
}

function messageKindOf(source: MessageSource): OpenVikingProjection["message_kind"] {
  if (source.role === "toolResult") return "tool_transport";
  if (source.role === "assistant") return "assistant_step";
  return "user_query";
}

function sameProjection(left: OpenVikingProjection, right: OpenVikingProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isProjectionPrefix(prefix: readonly OpenVikingProjection[], route: readonly OpenVikingProjection[]): boolean {
  return prefix.length <= route.length && prefix.every((projection, index) => sameProjection(projection, route[index]));
}

function entryIdsOf(projection: MemoryProjection): readonly string[] {
  return isOpaqueProviderSegment(projection) ? projection.entryIds : [projection.id];
}

function projectionsWithinEntryPrefix(
  projections: readonly MemoryProjection[],
  entryIds: readonly string[],
): MemoryProjection[] {
  const allowed = new Set(entryIds);
  return projections.filter((projection) => entryIdsOf(projection).every((id) => allowed.has(id)));
}

/** 精确前缀身份同时绑定 session、entry 顺序与可投影内容。 */
export function historicalRoutePrefixKey(
  route: SessionRouteIdentity,
  projections: readonly MemoryProjection[],
  coveredRouteEntryIds: readonly string[] = route.entryIds,
): string {
  return sha256({
    sessionId: route.sessionId,
    sessionFile: route.sessionFile,
    entryIds: coveredRouteEntryIds,
    projections: projectionsWithinEntryPrefix(projections, coveredRouteEntryIds),
  });
}

export function refreshTargetKey(target: RefreshTarget): string {
  return sha256(target);
}

function assertRouteInput(route: SessionRouteIdentity, projections: readonly MemoryProjection[]): void {
  const routeIds = new Set(route.entryIds);
  const projectionIds = new Set<string>();
  for (const projection of projections) {
    for (const id of entryIdsOf(projection)) {
      if (!routeIds.has(id)) throw new Error("Working memory projection is not part of its route identity");
      if (projectionIds.has(id)) throw new Error("Working memory projection identity is duplicated");
      projectionIds.add(id);
    }
  }
}

function assertRefreshable(projections: readonly MemoryProjection[]): void {
  if (projections.some(isOpaqueProviderSegment)) {
    throw new Error("A MemoryCheckpoint cannot cross an opaque Provider segment");
  }
}

function isEntryPrefix(prefix: readonly string[], route: readonly string[]): boolean {
  return prefix.length <= route.length && prefix.every((id, index) => route[index] === id);
}

function checkpointIdentity(checkpoint: Omit<MemoryCheckpoint, "identity">): string {
  return sha256(checkpoint);
}

export class OpenVikingSessionMemory {
  private readonly client: OpenVikingHttpClient;
  private readonly generation: string;
  private readonly capabilityProofId: string;
  private readonly commitPendingTokens: number;
  private readonly maxMirrors: number;
  private readonly maxCheckpoints: number;
  private readonly maxPendingRefreshes: number;
  private readonly taskTimeoutMs: number;
  private readonly taskPollMs: number;
  private readonly policy: RetentionPolicy;
  private readonly shutdownController = new AbortController();
  private readonly mirrors: RouteMirror[] = [];
  private readonly checkpoints = new Map<string, MemoryCheckpoint>();
  private readonly refreshes = new Map<string, RefreshJob>();
  private readonly queue: RefreshJob[] = [];
  private readonly cleanupTasks = new Set<Promise<void>>();
  private activeJob: RefreshJob | undefined;
  private drainTask: Promise<void> | undefined;
  private touchSequence = 0;

  constructor(
    baseUrl: string,
    apiKey: string | undefined,
    requestTimeoutMs = DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
    options: SessionWorkingMemoryOptions,
  ) {
    if (!options.generation) throw new Error("Working memory generation is required");
    if (!options.capabilityProofId) throw new Error("Working memory capability proof identity is required");
    this.client = new OpenVikingHttpClient(baseUrl, apiKey, requestTimeoutMs);
    this.generation = options.generation;
    this.capabilityProofId = options.capabilityProofId;
    this.commitPendingTokens = positiveInteger(options.commitPendingTokens, DEFAULT_COMMIT_PENDING_TOKENS, "Commit token threshold");
    this.maxMirrors = positiveInteger(options.maxMirrors, DEFAULT_MAX_MIRRORS, "Route mirror limit");
    this.maxCheckpoints = positiveInteger(options.maxCheckpoints, DEFAULT_MAX_CHECKPOINTS, "Checkpoint limit");
    this.maxPendingRefreshes = positiveInteger(options.maxPendingRefreshes, DEFAULT_MAX_PENDING_REFRESHES, "Pending refresh limit");
    this.taskTimeoutMs = positiveInteger(options.taskTimeoutMs, DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS, "Task timeout");
    this.taskPollMs = positiveInteger(options.taskPollMs, DEFAULT_TASK_POLL_MS, "Task poll interval");
    this.policy = {
      version: "openviking-session-retention-v1",
      contextTokenBudget: positiveInteger(options.contextTokenBudget, DEFAULT_CONTEXT_TOKEN_BUDGET, "Context token budget"),
      keepRecentMessages: nonNegativeInteger(options.keepRecentMessages, DEFAULT_KEEP_RECENT_MESSAGES, "Recent message count"),
    };
  }

  generationIdentity(): string {
    return this.generation;
  }

  retentionPolicy(): RetentionPolicy {
    return this.policy;
  }

  emptyCheckpoint(route: SessionRouteIdentity, retentionBudgetIdentity: string): MemoryCheckpoint {
    const checkpoint = {
      generation: this.generation,
      coveredRoutePrefixKey: historicalRoutePrefixKey(route, [], []),
      coveredRouteEntryIds: [],
      coveredThroughEntryId: null,
      retentionBudgetIdentity,
      sourceIds: [],
      workingMemory: "",
      activeHistory: [],
      assemblyHash: sha256({ overview: "", messages: [] }),
      producedUnderCapabilityProofId: this.capabilityProofId,
      openVikingSessionId: null,
    } satisfies Omit<MemoryCheckpoint, "identity">;
    return { ...checkpoint, identity: checkpointIdentity(checkpoint) };
  }

  findCompatibleCheckpoint(
    route: SessionRouteIdentity,
    projections: readonly MemoryProjection[],
    retentionBudgetIdentity: string,
    checkpointIdentity?: string,
  ): MemoryCheckpoint | undefined {
    assertRouteInput(route, projections);
    const candidates = [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.generation === this.generation
        && checkpoint.retentionBudgetIdentity === retentionBudgetIdentity
        && (checkpointIdentity === undefined || checkpoint.identity === checkpointIdentity)
        && isEntryPrefix(checkpoint.coveredRouteEntryIds, route.entryIds)
        && checkpoint.coveredRoutePrefixKey === historicalRoutePrefixKey(
          route,
          projections,
          checkpoint.coveredRouteEntryIds,
        ))
      .sort((left, right) => right.coveredRouteEntryIds.length - left.coveredRouteEntryIds.length);
    return candidates[0];
  }

  refreshCheckpoint(
    target: RefreshTarget,
    route: SessionRouteIdentity,
    projections: readonly MemoryProjection[],
    options: { required: boolean; signal?: AbortSignal },
  ): Promise<CheckpointRefreshResult> {
    assertRouteInput(route, projections);
    assertRefreshable(projections);
    this.assertTarget(target, route, projections);
    if (this.shutdownController.signal.aborted) return Promise.reject(new Error("Session Working Memory has stopped"));

    const key = refreshTargetKey(target);
    const existingCheckpoint = this.checkpoints.get(key);
    if (existingCheckpoint) return Promise.resolve({ kind: "accepted", checkpoint: existingCheckpoint });
    let job = this.refreshes.get(key);
    if (!job) {
      if (this.refreshes.size >= this.maxPendingRefreshes) {
        return Promise.reject(new Error("Session Working Memory refresh queue limit exceeded"));
      }
      job = this.createJob(key, target, route, projections, options.required);
      if (!options.required) this.collapseQueuedSuccessor(job);
      this.refreshes.set(key, job);
      this.queue.push(job);
      this.startDrain();
    } else if (options.required) {
      job.required = true;
    }
    return this.waitForJob(job.promise, options.signal);
  }

  private createJob(
    key: string,
    target: RefreshTarget,
    route: SessionRouteIdentity,
    projections: readonly MemoryProjection[],
    required: boolean,
  ): RefreshJob {
    let resolve!: (result: CheckpointRefreshResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CheckpointRefreshResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    return {
      key,
      target: structuredClone(target),
      route: structuredClone(route),
      projections: projections.map((projection) => structuredClone(projection)),
      required,
      started: false,
      promise,
      resolve,
      reject,
    };
  }

  /** 只有无人等待、尚未启动、同预算的线性后台后继可以替代旧目标。 */
  private collapseQueuedSuccessor(successor: RefreshJob): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const candidate = this.queue[index];
      if (candidate.started
        || candidate.required
        || candidate.route.sessionId !== successor.route.sessionId
        || candidate.route.sessionFile !== successor.route.sessionFile
        || candidate.target.generation !== successor.target.generation
        || candidate.target.retentionBudgetIdentity !== successor.target.retentionBudgetIdentity
        || !isEntryPrefix(candidate.route.entryIds, successor.route.entryIds)) continue;
      this.queue.splice(index, 1);
      this.refreshes.delete(candidate.key);
      candidate.resolve({ kind: "superseded" });
    }
  }

  private startDrain(): void {
    if (this.drainTask) return;
    const operation = this.drain().finally(() => {
      if (this.drainTask !== operation) return;
      this.drainTask = undefined;
      if (this.queue.length > 0 && !this.shutdownController.signal.aborted) this.startDrain();
    });
    this.drainTask = operation;
  }

  private async drain(): Promise<void> {
    while (!this.shutdownController.signal.aborted) {
      const job = this.queue.shift();
      if (!job) return;
      job.started = true;
      this.activeJob = job;
      try {
        const result = await this.executeRefresh(job);
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      } finally {
        if (this.activeJob === job) this.activeJob = undefined;
        this.refreshes.delete(job.key);
      }
    }
  }

  private async executeRefresh(job: RefreshJob): Promise<CheckpointRefreshResult> {
    const signal = this.shutdownController.signal;
    signal.throwIfAborted();
    const routeProjections = projectMemorySources(job.projections);
    const mirror = await this.findOrCreateMirror(job.route, routeProjections, signal);
    try {
      return await this.refreshMirror(job, mirror, routeProjections, signal);
    } catch (error) {
      this.retireMirror(mirror);
      throw error;
    }
  }

  private async refreshMirror(
    job: RefreshJob,
    mirror: RouteMirror,
    routeProjections: readonly OpenVikingProjection[],
    signal: AbortSignal,
  ): Promise<CheckpointRefreshResult> {
    const appended = routeProjections.slice(mirror.projections.length);
    for (const batch of appendBatches(appended)) {
      mirror.pendingTokens += Math.ceil(batch.reduce((total, projection) => total + projection.content.length, 0) / 4);
      const { result } = await this.client.request(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/messages/batch`,
        { messages: batch },
        signal,
      );
      mirror.pendingTokens = normalizeBatchPendingTokens(result) ?? mirror.pendingTokens;
    }
    mirror.projections = routeProjections.map((projection) => structuredClone(projection));
    mirror.touched = ++this.touchSequence;

    if (mirror.pendingTokens < this.commitPendingTokens && !job.required) {
      this.trimMirrors(mirror);
      return { kind: "skipped" };
    }
    const { result } = await this.client.request(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/commit`,
      { keep_recent_count: this.policy.keepRecentMessages },
      signal,
    );
    const commit = normalizeCommitResult(result);
    mirror.pendingTokens = 0;
    if (commit.status === "skipped") {
      if (job.required) throw new Error("Required checkpoint refresh was skipped by OpenViking");
      this.trimMirrors(mirror);
      return { kind: "skipped" };
    }

    await this.waitForTask(commit.taskId, signal);
    const checkpoint = await this.assembleCheckpoint(job, mirror, signal);
    if (refreshTargetKey(job.target) !== job.key) throw new Error("Checkpoint refresh target changed before publication");
    this.checkpoints.set(job.key, checkpoint);
    this.trimCheckpoints();
    this.trimMirrors(mirror);
    return { kind: "accepted", checkpoint };
  }

  private async findOrCreateMirror(
    route: SessionRouteIdentity,
    routeProjections: readonly OpenVikingProjection[],
    signal: AbortSignal,
  ): Promise<RouteMirror> {
    let mirror = this.mirrors
      .filter((candidate) => candidate.sessionId === route.sessionId
        && candidate.sessionFile === route.sessionFile
        && !candidate.retired
        && isProjectionPrefix(candidate.projections, routeProjections)
        && (candidate.projections.length < routeProjections.length || candidate.pendingTokens > 0))
      .sort((left, right) => right.projections.length - left.projections.length)[0];
    if (mirror) return mirror;
    await this.waitForCleanupCapacity();
    signal.throwIfAborted();
    mirror = {
      sessionId: route.sessionId,
      sessionFile: route.sessionFile,
      openVikingSessionId: `pcm-${sha256(`${route.sessionId}\0${route.fingerprint}`).slice(0, 16)}-${randomUUID()}`,
      projections: [],
      pendingTokens: 0,
      retired: false,
      touched: ++this.touchSequence,
    };
    try {
      await this.client.request("POST", "/api/v1/sessions", {
        session_id: mirror.openVikingSessionId,
        memory_policy: {
          self: { enabled: false },
          peer: { enabled: false },
          working_memory: { enabled: true },
        },
      }, signal);
    } catch (error) {
      await this.deleteOwnedSession(mirror.openVikingSessionId);
      throw error;
    }
    this.mirrors.push(mirror);
    return mirror;
  }

  private async assembleCheckpoint(
    job: RefreshJob,
    mirror: RouteMirror,
    signal: AbortSignal,
  ): Promise<MemoryCheckpoint> {
    const { result } = await this.client.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/context?token_budget=${this.policy.contextTokenBudget}`,
      undefined,
      signal,
    );
    const context = normalizeSessionContext(result);
    const sourceIds = job.projections.filter(isMessageSource).map((projection) => projection.id);
    const allowed = new Set(sourceIds);
    if (context.messages.some((message) => message.sourceMessageIds.some((id) => !allowed.has(id)))) {
      throw new Error("OpenViking checkpoint contains sources outside its RefreshTarget");
    }
    const checkpoint = {
      generation: this.generation,
      coveredRoutePrefixKey: job.target.routePrefixKey,
      coveredRouteEntryIds: [...job.route.entryIds],
      coveredThroughEntryId: job.target.watermark,
      retentionBudgetIdentity: job.target.retentionBudgetIdentity,
      sourceIds,
      workingMemory: context.overview,
      activeHistory: context.messages,
      assemblyHash: sha256(context),
      producedUnderCapabilityProofId: this.capabilityProofId,
      openVikingSessionId: mirror.openVikingSessionId,
    } satisfies Omit<MemoryCheckpoint, "identity">;
    return { ...checkpoint, identity: checkpointIdentity(checkpoint) };
  }

  private assertTarget(
    target: RefreshTarget,
    route: SessionRouteIdentity,
    projections: readonly MemoryProjection[],
  ): void {
    if (target.generation !== this.generation) throw new Error("Checkpoint refresh belongs to another runtime generation");
    if (!target.retentionBudgetIdentity) throw new Error("Checkpoint refresh has no retention budget identity");
    if (target.watermark !== (route.entryIds.at(-1) ?? null)) throw new Error("Checkpoint refresh watermark does not match its route");
    if (target.routePrefixKey !== historicalRoutePrefixKey(route, projections)) {
      throw new Error("Checkpoint refresh route prefix identity does not match its route");
    }
  }

  private async waitForJob(
    task: Promise<CheckpointRefreshResult>,
    signal?: AbortSignal,
  ): Promise<CheckpointRefreshResult> {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise<CheckpointRefreshResult>((resolve, reject) => {
      let settled = false;
      const finish = (result?: CheckpointRefreshResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(result!);
        else reject(error);
      };
      const onAbort = () => finish(undefined, signal.reason ?? new Error("Checkpoint refresh wait cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      void task.then((result) => finish(result), (error) => finish(undefined, error));
    });
  }

  private async waitForTask(taskId: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.taskTimeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const { result } = await this.client.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`, undefined, signal);
      const task = normalizeTaskState(result);
      if (task.status === "completed") return;
      if (task.status === "failed" || task.status === "cancelled") {
        throw new Error(`OpenViking working memory task ${task.status}: ${String(task.error ?? "unknown error")}`);
      }
      if (task.status !== "pending" && task.status !== "running" && task.status !== "cancelling") {
        throw new Error(`OpenViking working memory task returned unknown status ${task.status}`);
      }
      await new Promise<void>((resolveDelay, rejectDelay) => {
        const finish = (error?: unknown) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          if (error === undefined) resolveDelay();
          else rejectDelay(error);
        };
        const timeout = setTimeout(() => finish(), this.taskPollMs);
        const onAbort = () => finish(signal.reason ?? new Error("Working memory refresh cancelled"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("OpenViking working memory task timed out");
  }
  private async waitForCleanupCapacity(): Promise<void> {
    while (this.cleanupTasks.size >= this.maxMirrors) {
      await Promise.race(this.cleanupTasks);
    }
  }

  private trimCheckpoints(): void {
    while (this.checkpoints.size > this.maxCheckpoints) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
  }

  private trimMirrors(current: RouteMirror): void {
    while (this.mirrors.filter((candidate) => !candidate.retired).length > this.maxMirrors) {
      const oldest = this.mirrors
        .filter((candidate) => !candidate.retired && candidate !== current)
        .sort((left, right) => left.touched - right.touched)[0];
      if (!oldest) break;
      this.retireMirror(oldest);
    }
  }

  private retireMirror(mirror: RouteMirror): void {
    if (mirror.retired) return;
    mirror.retired = true;
    this.removeMirror(mirror);
  }

  private removeMirror(mirror: RouteMirror): void {
    const index = this.mirrors.indexOf(mirror);
    if (index < 0) return;
    this.mirrors.splice(index, 1);
    const task = this.deleteOwnedSession(mirror.openVikingSessionId).finally(() => this.cleanupTasks.delete(task));
    this.cleanupTasks.add(task);
  }

  private async deleteOwnedSession(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.client.request("DELETE", `/api/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, AbortSignal.timeout(500));
        return;
      } catch {
        if (attempt === 4) return;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
  }

  async shutdown(reason: unknown = new Error("Session Working Memory stopped")): Promise<void> {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort(reason);
    for (const job of this.queue.splice(0)) {
      this.refreshes.delete(job.key);
      job.reject(reason);
    }
    if (this.drainTask) await this.drainTask.catch(() => undefined);
    this.checkpoints.clear();
    const mirrors = this.mirrors.splice(0);
    for (const mirror of mirrors) {
      const task = this.deleteOwnedSession(mirror.openVikingSessionId).finally(() => this.cleanupTasks.delete(task));
      this.cleanupTasks.add(task);
    }
    while (this.cleanupTasks.size > 0) await Promise.allSettled([...this.cleanupTasks]);
  }
}
