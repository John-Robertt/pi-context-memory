import { createHash, randomUUID } from "node:crypto";

import type { SourceEntry } from "./long-term-memory.ts";
import {
  OpenVikingHttpClient,
  normalizeBatchPendingTokens,
  normalizeCommitResult,
  normalizeSessionContext,
  normalizeTaskState,
  type NormalizedSessionContext,
} from "./openviking-protocol.ts";
import { effectivePiProjectionEntries } from "./pi-session-protocol.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";

const MAX_ENTRY_CHARS = 24_000;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 12_000;
const DEFAULT_COMMIT_PENDING_TOKENS = 6_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_MIRRORS = 8;
export const DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS = 180_000;
const DEFAULT_TASK_POLL_MS = 100;
export interface SessionWorkingMemoryOptions {
  contextTokenBudget?: number;
  commitPendingTokens?: number;
  keepRecentMessages?: number;
  maxMirrors?: number;
  taskTimeoutMs?: number;
  taskPollMs?: number;
}

export interface OpenVikingProjection {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  turn_id: string;
  message_kind: "user_query" | "assistant_step" | "tool_transport" | "checkpoint";
  source_message_ids: string[];
}

export type AssembledSessionContext = NormalizedSessionContext;

export interface PreparedSessionMemory {
  route: SessionRouteIdentity;
  openVikingSessionId: string;
  context: AssembledSessionContext;
}

interface CommitFlight {
  taskId: string;
  done: Promise<void>;
}

interface RouteMirror {
  sessionId: string;
  sessionFile: string;
  openVikingSessionId: string;
  projections: readonly OpenVikingProjection[];
  pendingTokens: number;
  revision: number;
  latestRoute?: SessionRouteIdentity;
  commitFlight?: CommitFlight;
  retired: boolean;
  touched: number;
}
interface PrepareJob {
  kind: "prepare";
  key: string;
  route: SessionRouteIdentity;
  entries: readonly SourceEntry[];
  signal?: AbortSignal;
  resolve: (prepared: PreparedSessionMemory) => void;
  reject: (error: unknown) => void;
}
interface PromotionJob {
  kind: "promotion";
  mirror: RouteMirror;
  flight: CommitFlight;
  completed: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}
type QueueJob = PrepareJob | PromotionJob;

interface FastPreparation {
  active: PreparedSessionMemory;
  flight?: CommitFlight;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function boundedMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n… content omitted …\n";
  const half = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return `${value.slice(0, half)}${marker}${value.slice(-half)}`;
}

export function projectRouteEntries(entries: readonly SourceEntry[]): OpenVikingProjection[] {
  const projections: OpenVikingProjection[] = [];
  const effectiveEntries = effectivePiProjectionEntries(entries);
  let turnId = "route-start";
  for (const entry of effectiveEntries) {
    if (!entry.text) continue;
    if (entry.projectionKind === "user_query") turnId = entry.source.id;
    projections.push({
      role: entry.projectionRole,
      content: boundedMiddle(`[Pi entry ${entry.source.id}; ${entry.source.type}]\n${entry.text}`, MAX_ENTRY_CHARS),
      created_at: entry.source.timestamp,
      turn_id: turnId,
      message_kind: entry.projectionKind,
      source_message_ids: [entry.source.id],
    });
  }
  return projections;
}

function sameProjection(left: OpenVikingProjection, right: OpenVikingProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isProjectionPrefix(prefix: readonly OpenVikingProjection[], route: readonly OpenVikingProjection[]): boolean {
  return prefix.length <= route.length && prefix.every((projection, index) => sameProjection(projection, route[index]));
}

function assertRouteInput(route: SessionRouteIdentity, entries: readonly SourceEntry[]): void {
  if (route.entryIds.length !== entries.length) throw new Error("Working memory route entry count differs from its identity");
  for (let index = 0; index < entries.length; index += 1) {
    if (route.entryIds[index] !== entries[index].id) throw new Error("Working memory route entries differ from its identity");
  }
}

export class OpenVikingSessionMemory {
  private readonly client: OpenVikingHttpClient;
  private readonly contextTokenBudget: number;
  private readonly commitPendingTokens: number;
  private readonly keepRecentMessages: number;
  private readonly maxMirrors: number;
  private readonly taskTimeoutMs: number;
  private readonly taskPollMs: number;
  private readonly shutdownController = new AbortController();
  private readonly pending = new Map<string, Promise<PreparedSessionMemory>>();
  private readonly ready = new Map<string, PreparedSessionMemory>();
  private readonly mirrors: RouteMirror[] = [];
  private readonly queue: QueueJob[] = [];
  private activeDrain: Promise<void> | undefined;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private touchSequence = 0;

  constructor(
    baseUrl = "http://127.0.0.1:1933",
    apiKey?: string,
    requestTimeoutMs = 30_000,
    options: SessionWorkingMemoryOptions = {},
  ) {
    this.client = new OpenVikingHttpClient(baseUrl, apiKey, requestTimeoutMs);
    this.contextTokenBudget = positiveInteger(options.contextTokenBudget, DEFAULT_CONTEXT_TOKEN_BUDGET, "Context token budget");
    this.commitPendingTokens = positiveInteger(options.commitPendingTokens, DEFAULT_COMMIT_PENDING_TOKENS, "Commit token threshold");
    this.keepRecentMessages = nonNegativeInteger(options.keepRecentMessages, DEFAULT_KEEP_RECENT_MESSAGES, "Recent message count");
    this.maxMirrors = positiveInteger(options.maxMirrors, DEFAULT_MAX_MIRRORS, "Route mirror limit");
    this.taskTimeoutMs = positiveInteger(options.taskTimeoutMs, DEFAULT_WORKING_MEMORY_TASK_TIMEOUT_MS, "Task timeout");
    this.taskPollMs = positiveInteger(options.taskPollMs, DEFAULT_TASK_POLL_MS, "Task poll interval");
  }

  getReady(route: SessionRouteIdentity): PreparedSessionMemory | undefined {
    const prepared = this.ready.get(route.fingerprint);
    if (!prepared) return undefined;
    return prepared.route.sessionId === route.sessionId
      && prepared.route.sessionFile === route.sessionFile
      && prepared.route.leafId === route.leafId
      && JSON.stringify(prepared.route.entryIds) === JSON.stringify(route.entryIds)
      ? prepared
      : undefined;
  }

  async waitForReady(
    route: SessionRouteIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PreparedSessionMemory | undefined> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Ready wait timeout must be a non-negative integer");
    const existing = this.getReady(route);
    if (existing || timeoutMs === 0 || !this.pending.has(route.fingerprint)) return existing;

    const deadline = Date.now() + timeoutMs;
    while (this.pending.has(route.fingerprint) && Date.now() < deadline) {
      signal?.throwIfAborted();
      const prepared = this.getReady(route);
      if (prepared) return prepared;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(5, deadline - Date.now())));
    }
    signal?.throwIfAborted();
    return this.getReady(route);
  }

  prepare(
    route: SessionRouteIdentity,
    entries: readonly SourceEntry[],
    signal?: AbortSignal,
  ): Promise<PreparedSessionMemory> {
    assertRouteInput(route, entries);
    if (this.shutdownController.signal.aborted) return Promise.reject(new Error("Session Working Memory has stopped"));
    const existing = this.getReady(route);
    if (existing) return Promise.resolve(existing);
    const pending = this.pending.get(route.fingerprint);
    if (pending) return pending;

    let resolveJob!: (prepared: PreparedSessionMemory) => void;
    let rejectJob!: (error: unknown) => void;
    const task = new Promise<PreparedSessionMemory>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (queued.kind !== "prepare" || queued.route.sessionId !== route.sessionId) continue;
      this.queue.splice(index, 1);
      this.pending.delete(queued.key);
      queued.reject(new Error("Session Working Memory preparation was superseded by a newer route"));
    }
    this.queue.push({
      kind: "prepare",
      key: route.fingerprint,
      route: structuredClone(route),
      entries: entries.map((entry) => structuredClone(entry)),
      signal,
      resolve: resolveJob,
      reject: rejectJob,
    });
    this.pending.set(route.fingerprint, task);
    this.startDrain();
    return task;
  }

  private startDrain(): void {
    if (this.activeDrain) return;
    const operation = this.drainQueue().finally(() => {
      if (this.activeDrain !== operation) return;
      this.activeDrain = undefined;
      if (this.queue.length > 0 && !this.shutdownController.signal.aborted) this.startDrain();
    });
    this.activeDrain = operation;
  }

  private async drainQueue(): Promise<void> {
    while (true) {
      const job = this.queue.shift();
      if (!job) return;
      if (job.kind === "promotion") {
        try {
          await this.promoteSerial(job.mirror, job.flight, job.completed);
          job.resolve();
        } catch (error) {
          job.reject(error);
        }
        continue;
      }
      try {
        const prepared = await this.prepareFast(job.route, job.entries, job.signal);
        this.ready.set(job.key, prepared.active);
        this.trimReady();
        if (prepared.flight) this.settleAfterFlight(job, prepared);
        else {
          this.pending.delete(job.key);
          job.resolve(prepared.active);
        }
      } catch (error) {
        this.ready.delete(job.key);
        this.discardMirrorsForRoute(job.route, job.entries);
        this.pending.delete(job.key);
        job.reject(error);
      }
    }
  }

  async shutdown(reason: unknown = new Error("Session Working Memory stopped")): Promise<void> {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort(reason);
    for (const job of this.queue.splice(0)) job.reject(reason);
    if (this.activeDrain) await this.activeDrain.catch(() => undefined);
    while (this.backgroundTasks.size > 0) await Promise.allSettled([...this.backgroundTasks]);
    this.pending.clear();
    this.ready.clear();
    const sessionIds = this.mirrors.splice(0).map((mirror) => mirror.openVikingSessionId);
    for (const sessionId of sessionIds) this.scheduleSessionDeletion(sessionId);
    while (this.cleanupTasks.size > 0) await Promise.allSettled([...this.cleanupTasks]);
  }

  private async prepareFast(
    route: SessionRouteIdentity,
    entries: readonly SourceEntry[],
    signal?: AbortSignal,
  ): Promise<FastPreparation> {
    const operationSignal = signal
      ? AbortSignal.any([this.shutdownController.signal, signal])
      : this.shutdownController.signal;
    operationSignal.throwIfAborted();

    const routeProjections = projectRouteEntries(entries);
    let mirror = this.mirrors
      .filter((candidate) => candidate.sessionId === route.sessionId
        && candidate.sessionFile === route.sessionFile
        && !candidate.retired
        && isProjectionPrefix(candidate.projections, routeProjections))
      .sort((left, right) => right.projections.length - left.projections.length)[0];
    if (!mirror) {
      mirror = {
        sessionId: route.sessionId,
        sessionFile: route.sessionFile,
        openVikingSessionId: `pcm-${sha256(`${route.sessionId}\0${route.fingerprint}`).slice(0, 16)}-${randomUUID()}`,
        projections: [],
        pendingTokens: 0,
        revision: 0,
        retired: false,
        touched: ++this.touchSequence,
      };
      this.mirrors.push(mirror);
      await this.client.request("POST", "/api/v1/sessions", {
        session_id: mirror.openVikingSessionId,
        memory_policy: {
          self: { enabled: false },
          peer: { enabled: false },
          working_memory: { enabled: true },
        },
      }, operationSignal);
    }

    const appendedProjections = routeProjections.slice(mirror.projections.length);
    for (let index = 0; index < appendedProjections.length; index += 100) {
      const batch = appendedProjections.slice(index, index + 100);
      mirror.pendingTokens += Math.ceil(batch.reduce((total, projection) => total + projection.content.length, 0) / 4);
      const { result } = await this.client.request(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/messages/batch`,
        { messages: batch },
        operationSignal,
      );
      mirror.pendingTokens = normalizeBatchPendingTokens(result) ?? mirror.pendingTokens;
    }
    mirror.projections = routeProjections.map((projection) => structuredClone(projection));
    mirror.latestRoute = structuredClone(route);
    mirror.revision += 1;
    mirror.touched = ++this.touchSequence;

    await this.maybeStartCommit(mirror, operationSignal);
    const active = await this.assembleContext(route, mirror, operationSignal);
    this.trimMirrors(mirror);
    return mirror.commitFlight ? { active, flight: mirror.commitFlight } : { active };
  }

  private settleAfterFlight(job: PrepareJob, prepared: FastPreparation): void {
    const flight = prepared.flight;
    if (!flight) return;
    void this.waitForFlight(flight, job.signal).then(
      () => {
        if (this.shutdownController.signal.aborted) {
          job.reject(this.shutdownController.signal.reason ?? new Error("Session Working Memory stopped"));
        } else {
          job.resolve(this.getReady(job.route) ?? prepared.active);
        }
      },
      (error) => job.reject(error),
    ).finally(() => this.pending.delete(job.key));
  }

  private async waitForFlight(flight: CommitFlight, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await flight.done;
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolveWait, rejectWait) => {
      const finish = (error?: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolveWait();
        else rejectWait(error);
      };
      const onAbort = () => finish(signal.reason ?? new Error("Working memory preparation cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      void flight.done.then(() => finish(), (error) => finish(error));
    });
  }

  private async maybeStartCommit(mirror: RouteMirror, signal: AbortSignal): Promise<void> {
    if (mirror.retired || mirror.commitFlight || mirror.pendingTokens < this.commitPendingTokens) return;
    const { result } = await this.client.request(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/commit`,
      { keep_recent_count: this.keepRecentMessages },
      signal,
    );
    const commit = normalizeCommitResult(result);
    mirror.pendingTokens = 0;
    if (commit.status === "accepted") this.startCommitFlight(mirror, commit.taskId);
  }

  private startCommitFlight(mirror: RouteMirror, taskId: string): void {
    const flight: CommitFlight = { taskId, done: Promise.resolve() };
    mirror.commitFlight = flight;
    const task = this.runCommitFlight(mirror, flight)
      .catch(() => undefined)
      .finally(() => this.backgroundTasks.delete(task));
    flight.done = task;
    this.backgroundTasks.add(task);
  }

  private async runCommitFlight(mirror: RouteMirror, flight: CommitFlight): Promise<void> {
    let completed = false;
    try {
      await this.waitForTask(flight.taskId, this.shutdownController.signal);
      completed = true;
    } catch {
      // The Phase 1 source-verifiable context remains valid when Phase 2 fails or times out.
    }
    if (this.shutdownController.signal.aborted) {
      if (mirror.commitFlight === flight) mirror.commitFlight = undefined;
      return;
    }
    await this.enqueuePromotion(mirror, flight, completed);
  }

  private enqueuePromotion(mirror: RouteMirror, flight: CommitFlight, completed: boolean): Promise<void> {
    const promotion = new Promise<void>((resolvePromotion, rejectPromotion) => {
      this.queue.push({
        kind: "promotion",
        mirror,
        flight,
        completed,
        resolve: resolvePromotion,
        reject: rejectPromotion,
      });
    });
    this.startDrain();
    return promotion;
  }

  private async promoteSerial(mirror: RouteMirror, flight: CommitFlight, completed: boolean): Promise<void> {
    if (mirror.commitFlight !== flight) return;
    mirror.commitFlight = undefined;
    if (mirror.retired) {
      this.removeMirror(mirror);
      return;
    }
    const route = mirror.latestRoute;
    const revision = mirror.revision;
    if (completed && route) {
      try {
        const promoted = await this.assembleContext(route, mirror, this.shutdownController.signal);
        if (!mirror.retired
          && mirror.revision === revision
          && mirror.latestRoute?.fingerprint === route.fingerprint) {
          this.ready.set(route.fingerprint, promoted);
          this.trimReady();
        }
      } catch {
        // Keep the last source-verifiable active context when final assembly is unavailable.
      }
    }
    try {
      await this.maybeStartCommit(mirror, this.shutdownController.signal);
    } catch {
      // A later route preparation may retry the still-pending live tail.
    }
    this.trimMirrors(mirror);
  }

  private async assembleContext(
    route: SessionRouteIdentity,
    mirror: RouteMirror,
    signal: AbortSignal,
  ): Promise<PreparedSessionMemory> {
    const { result: assembled } = await this.client.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/context?token_budget=${this.contextTokenBudget}`,
      undefined,
      signal,
    );
    const context = normalizeSessionContext(assembled);
    const routeIds = new Set(route.entryIds);
    if (context.messages.some((message) => message.sourceMessageIds.some((id) => !routeIds.has(id)))) {
      throw new Error("OpenViking context contains sources outside the current Pi route");
    }
    return { route, openVikingSessionId: mirror.openVikingSessionId, context };
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
        const onAbort = () => finish(signal.reason ?? new Error("Working memory preparation cancelled"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("OpenViking working memory task timed out");
  }

  private discardMirrorsForRoute(route: SessionRouteIdentity, entries: readonly SourceEntry[]): void {
    const routeProjections = projectRouteEntries(entries);
    for (const mirror of [...this.mirrors]) {
      if (mirror.sessionId !== route.sessionId
        || mirror.sessionFile !== route.sessionFile
        || !isProjectionPrefix(mirror.projections, routeProjections)) continue;
      this.retireMirror(mirror);
    }
  }

  private trimReady(): void {
    while (this.ready.size > this.maxMirrors) {
      const oldest = this.ready.keys().next().value as string | undefined;
      if (!oldest) break;
      this.ready.delete(oldest);
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
    for (const [key, prepared] of this.ready) {
      if (prepared.openVikingSessionId === mirror.openVikingSessionId) this.ready.delete(key);
    }
    if (!mirror.commitFlight) this.removeMirror(mirror);
  }

  private removeMirror(mirror: RouteMirror): void {
    const index = this.mirrors.indexOf(mirror);
    if (index < 0) return;
    this.mirrors.splice(index, 1);
    this.scheduleSessionDeletion(mirror.openVikingSessionId);
  }
  private scheduleSessionDeletion(sessionId: string): void {
    const task = this.deleteOwnedSession(sessionId).finally(() => this.cleanupTasks.delete(task));
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

}
