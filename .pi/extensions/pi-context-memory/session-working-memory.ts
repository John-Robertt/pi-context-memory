import { createHash, randomUUID } from "node:crypto";

import type { SourceEntry } from "./long-term-memory.ts";
import {
  OpenVikingHttpClient,
  normalizeBatchPendingTokens,
  normalizeCommitTaskId,
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
const DEFAULT_TASK_TIMEOUT_MS = 60_000;
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

interface RouteMirror {
  openVikingSessionId: string;
  projections: readonly OpenVikingProjection[];
  pendingTokens: number;
  touched: number;
}
interface PrepareJob {
  key: string;
  route: SessionRouteIdentity;
  entries: readonly SourceEntry[];
  signal?: AbortSignal;
  resolve: (prepared: PreparedSessionMemory) => void;
  reject: (error: unknown) => void;
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
  private readonly queue: PrepareJob[] = [];
  private activeDrain: Promise<void> | undefined;
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
    this.taskTimeoutMs = positiveInteger(options.taskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS, "Task timeout");
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
      if (queued.route.sessionId !== route.sessionId) continue;
      this.queue.splice(index, 1);
      this.pending.delete(queued.key);
      queued.reject(new Error("Session Working Memory preparation was superseded by a newer route"));
    }
    this.queue.push({
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
      if (this.activeDrain === operation) this.activeDrain = undefined;
    });
    this.activeDrain = operation;
  }

  private async drainQueue(): Promise<void> {
    while (true) {
      const job = this.queue.shift();
      if (!job) return;
      try {
        const prepared = await this.prepareSerial(job.route, job.entries, job.signal);
        this.ready.set(job.key, prepared);
        this.trimReady();
        job.resolve(prepared);
      } catch (error) {
        this.discardMirrorsForRoute(job.entries);
        job.reject(error);
      } finally {
        this.pending.delete(job.key);
      }
    }
  }

  async shutdown(reason: unknown = new Error("Session Working Memory stopped")): Promise<void> {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort(reason);
    for (const job of this.queue.splice(0)) job.reject(reason);
    this.pending.clear();
    if (this.activeDrain) await this.activeDrain.catch(() => undefined);
    this.ready.clear();
    const sessionIds = this.mirrors.splice(0).map((mirror) => mirror.openVikingSessionId);
    for (const sessionId of sessionIds) this.scheduleSessionDeletion(sessionId);
    while (this.cleanupTasks.size > 0) await Promise.allSettled([...this.cleanupTasks]);
  }

  private async prepareSerial(
    route: SessionRouteIdentity,
    entries: readonly SourceEntry[],
    signal?: AbortSignal,
  ): Promise<PreparedSessionMemory> {
    const operationSignal = signal
      ? AbortSignal.any([this.shutdownController.signal, signal])
      : this.shutdownController.signal;
    operationSignal.throwIfAborted();

    const routeProjections = projectRouteEntries(entries);
    let mirror = this.mirrors
      .filter((candidate) => isProjectionPrefix(candidate.projections, routeProjections))
      .sort((left, right) => right.projections.length - left.projections.length)[0];
    if (!mirror) {
      mirror = {
        openVikingSessionId: `pcm-${sha256(`${route.sessionId}\0${route.fingerprint}`).slice(0, 16)}-${randomUUID()}`,
        projections: [],
        pendingTokens: 0,
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
    mirror.touched = ++this.touchSequence;

    if (mirror.pendingTokens >= this.commitPendingTokens) {
      const { result } = await this.client.request(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/commit`,
        { keep_recent_count: this.keepRecentMessages },
        operationSignal,
      );
      await this.waitForTask(normalizeCommitTaskId(result), operationSignal);
      mirror.pendingTokens = 0;
    }

    const { result: assembled } = await this.client.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/context?token_budget=${this.contextTokenBudget}`,
      undefined,
      operationSignal,
    );
    const context = normalizeSessionContext(assembled);
    const routeIds = new Set(route.entryIds);
    if (context.messages.some((message) => message.sourceMessageIds.some((id) => !routeIds.has(id)))) {
      throw new Error("OpenViking context contains sources outside the current Pi route");
    }
    this.trimMirrors(mirror);
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

  private discardMirrorsForRoute(entries: readonly SourceEntry[]): void {
    const routeProjections = projectRouteEntries(entries);
    for (let index = this.mirrors.length - 1; index >= 0; index -= 1) {
      if (!isProjectionPrefix(this.mirrors[index].projections, routeProjections)) continue;
      const [removed] = this.mirrors.splice(index, 1);
      this.scheduleSessionDeletion(removed.openVikingSessionId);
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
    while (this.mirrors.length > this.maxMirrors) {
      const oldest = this.mirrors
        .filter((candidate) => candidate !== current)
        .sort((left, right) => left.touched - right.touched)[0];
      if (!oldest) break;
      this.mirrors.splice(this.mirrors.indexOf(oldest), 1);
      this.scheduleSessionDeletion(oldest.openVikingSessionId);
    }
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
