import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { SourceEntry } from "./long-term-memory.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_CHARS = 24_000;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 12_000;
const DEFAULT_COMMIT_PENDING_TOKENS = 6_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;
const DEFAULT_MAX_MIRRORS = 8;
const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_TASK_POLL_MS = 100;
const WORKING_MEMORY_SECTIONS = [
  "Session Title",
  "Current State",
  "Task & Goals",
  "Key Facts & Decisions",
  "Files & Context",
  "Errors & Corrections",
  "Open Issues",
] as const;

export function isStructuredWorkingMemoryOverview(value: string): boolean {
  const headings = value.split(/\r?\n/)
    .map((line) => /^## ([^#].*)$/.exec(line)?.[1]?.trim())
    .filter((heading): heading is string => heading !== undefined);
  return headings.length === WORKING_MEMORY_SECTIONS.length
    && headings.every((heading, index) => heading === WORKING_MEMORY_SECTIONS[index]);
}

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

export interface AssembledSessionContext {
  latestArchiveOverview: string;
  messages: unknown[];
  estimatedTokens: number;
}

export interface PreparedSessionMemory {
  route: SessionRouteIdentity;
  openVikingSessionId: string;
  context: AssembledSessionContext;
}

interface RouteMirror {
  openVikingSessionId: string;
  projections: readonly OpenVikingProjection[];
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

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenViking URL must use HTTP or HTTPS");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const ipv4 = isIP(hostname) === 4 ? hostname.split(".").map(Number) : undefined;
  const loopback = hostname === "localhost" || hostname === "::1" || (ipv4 !== undefined && ipv4[0] === 127);
  if (url.protocol === "http:" && !loopback) throw new Error("Remote OpenViking URLs must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function envelopeResult(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("OpenViking returned an invalid JSON envelope");
  const envelope = value as Record<string, unknown>;
  if (envelope.status === "error") {
    const error = envelope.error && typeof envelope.error === "object"
      ? envelope.error as Record<string, unknown>
      : undefined;
    throw new Error(`OpenViking error: ${String(error?.message ?? "unknown error")}`);
  }
  return "result" in envelope ? envelope.result : envelope;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
    if (value.type === "toolCall") {
      parts.push(`Tool call ${String(value.name ?? "unknown")}: ${JSON.stringify(value.arguments ?? {})}`);
    }
    if (value.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

function boundedMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n… content omitted …\n";
  const half = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return `${value.slice(0, half)}${marker}${value.slice(-half)}`;
}

function entryText(entry: SourceEntry): string {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    if (message.role === "bashExecution") {
      return [`Command: ${String(message.command ?? "")}`, `Output:\n${String(message.output ?? "")}`].join("\n");
    }
    return [
      typeof message.toolName === "string" ? `Tool: ${message.toolName}` : "",
      typeof message.isError === "boolean" ? `Tool error: ${message.isError}` : "",
      textContent(message.content),
    ].filter(Boolean).join("\n");
  }
  if (entry.type === "compaction" && Array.isArray((entry as unknown as Record<string, unknown>).retainedTail)) {
    const retainedTail = ((entry as unknown as Record<string, unknown>).retainedTail as unknown[]).map((message) => {
      if (!message || typeof message !== "object") return String(message ?? "");
      const value = message as Record<string, unknown>;
      return `[retained ${String(value.role ?? "message")}]\n${textContent(value.content)}`;
    }).filter(Boolean).join("\n\n");
    return [typeof entry.summary === "string" ? entry.summary : "", retainedTail].filter(Boolean).join("\n\n");
  }
  if (typeof entry.summary === "string") return entry.summary;
  if (entry.type === "custom_message") return textContent(entry.content);
  return "";
}

function projectionKind(entry: SourceEntry): OpenVikingProjection["message_kind"] {
  if (entry.type === "compaction" || entry.type === "branch_summary") return "checkpoint";
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return "checkpoint";
  const role = (entry.message as Record<string, unknown>).role;
  if (role === "user") return "user_query";
  if (role === "assistant") return "assistant_step";
  if (role === "toolResult" || role === "bashExecution") return "tool_transport";
  return "checkpoint";
}
function effectiveProjectionEntries(entries: readonly SourceEntry[]): readonly SourceEntry[] {
  const compactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  if (compactionIndex < 0) return entries;
  const compaction = entries[compactionIndex];
  const afterCompaction = entries.slice(compactionIndex + 1);
  if (Array.isArray((compaction as unknown as Record<string, unknown>).retainedTail)) {
    return [compaction, ...afterCompaction];
  }
  const firstKeptEntryId = (compaction as unknown as Record<string, unknown>).firstKeptEntryId;
  const firstKeptIndex = typeof firstKeptEntryId === "string"
    ? entries.findIndex((entry, index) => index < compactionIndex && entry.id === firstKeptEntryId)
    : -1;
  const retainedEntries = firstKeptIndex >= 0 ? entries.slice(firstKeptIndex, compactionIndex) : [];
  return [compaction, ...retainedEntries, ...afterCompaction];
}

export function projectRouteEntries(entries: readonly SourceEntry[]): OpenVikingProjection[] {
  const projections: OpenVikingProjection[] = [];
  const effectiveEntries = effectiveProjectionEntries(entries);
  let turnId = "route-start";
  for (const entry of effectiveEntries) {
    const content = entryText(entry).trim();
    if (!content) continue;
    const kind = projectionKind(entry);
    if (kind === "user_query") turnId = entry.id;
    const role = entry.type === "message"
      && entry.message
      && typeof entry.message === "object"
      && (entry.message as Record<string, unknown>).role === "assistant"
      ? "assistant"
      : "user";
    projections.push({
      role,
      content: boundedMiddle(`[Pi entry ${entry.id}; ${entry.type}]\n${content}`, MAX_ENTRY_CHARS),
      created_at: entry.timestamp,
      turn_id: turnId,
      message_kind: kind,
      source_message_ids: [entry.id],
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
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
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
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.requestTimeoutMs = positiveInteger(requestTimeoutMs, 30_000, "OpenViking request timeout");
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
        touched: ++this.touchSequence,
      };
      this.mirrors.push(mirror);
      await this.request("POST", "/api/v1/sessions", {
        session_id: mirror.openVikingSessionId,
        memory_policy: {
          self: { enabled: false },
          peer: { enabled: false },
          working_memory: { enabled: true },
        },
      }, operationSignal);
    }

    const appendedProjections = routeProjections.slice(mirror.projections.length);
    let pendingTokens = 0;
    for (let index = 0; index < appendedProjections.length; index += 100) {
      const result = await this.request(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/messages/batch`,
        { messages: appendedProjections.slice(index, index + 100) },
        operationSignal,
      );
      if (!result || typeof result !== "object") throw new Error("OpenViking batch response is invalid");
      const value = result as Record<string, unknown>;
      if (typeof value.pending_tokens !== "number" || !Number.isFinite(value.pending_tokens)) {
        throw new Error("OpenViking batch response has no pending token count");
      }
      pendingTokens = value.pending_tokens;
    }
    mirror.projections = routeProjections.map((projection) => structuredClone(projection));
    mirror.touched = ++this.touchSequence;

    if (pendingTokens >= this.commitPendingTokens) {
      const commit = await this.request(
        "POST",
        `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/commit`,
        { keep_recent_count: this.keepRecentMessages },
        operationSignal,
      );
      if (!commit || typeof commit !== "object" || typeof (commit as Record<string, unknown>).task_id !== "string") {
        throw new Error("OpenViking commit response has no task ID");
      }
      await this.waitForTask((commit as Record<string, unknown>).task_id as string, operationSignal);
    }

    const assembled = await this.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(mirror.openVikingSessionId)}/context?token_budget=${this.contextTokenBudget}`,
      undefined,
      operationSignal,
    );
    const context = this.parseContext(assembled);
    this.trimMirrors(mirror);
    return { route, openVikingSessionId: mirror.openVikingSessionId, context };
  }

  private parseContext(value: unknown): AssembledSessionContext {
    if (!value || typeof value !== "object") throw new Error("OpenViking context response is invalid");
    const context = value as Record<string, unknown>;
    if (typeof context.latest_archive_overview !== "string" || !Array.isArray(context.messages)) {
      throw new Error("OpenViking context response has invalid fields");
    }
    const overview = context.latest_archive_overview.trim();
    if (overview && !isStructuredWorkingMemoryOverview(overview)) {
      throw new Error("OpenViking returned an incomplete Working Memory overview");
    }
    if (typeof context.estimatedTokens !== "number" || !Number.isFinite(context.estimatedTokens)) {
      throw new Error("OpenViking context response has no token estimate");
    }
    return {
      latestArchiveOverview: context.latest_archive_overview,
      messages: context.messages,
      estimatedTokens: context.estimatedTokens,
    };
  }

  private async waitForTask(taskId: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.taskTimeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const result = await this.request("GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`, undefined, signal);
      if (!result || typeof result !== "object") throw new Error("OpenViking task response is invalid");
      const value = result as Record<string, unknown>;
      const status = value.status;
      if (status === "completed") return;
      if (status === "failed" || status === "cancelled") {
        throw new Error(`OpenViking working memory task ${String(status)}: ${String(value.error ?? "unknown error")}`);
      }
      if (status !== "pending" && status !== "running" && status !== "cancelling") {
        throw new Error(`OpenViking working memory task returned unknown status ${String(status)}`);
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
        await this.request("DELETE", `/api/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, AbortSignal.timeout(500));
        return;
      } catch {
        if (attempt === 4) return;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    }
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const serializedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (serializedBody) headers["content-length"] = String(serializedBody.length);
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const url = new URL(`${this.baseUrl}${path}`);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    let status = 0;
    let statusText = "";
    let text: string;
    try {
      text = await new Promise<string>((resolveResponse, rejectResponse) => {
        const request = transport(url, {
          method,
          headers,
          signal: this.requestSignal(signal),
        }, (response) => {
          status = response.statusCode ?? 0;
          statusText = response.statusMessage ?? "";
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on("data", (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("OpenViking response exceeded 10 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => resolveResponse(Buffer.concat(chunks).toString("utf8")));
          response.on("error", rejectResponse);
        });
        request.on("error", rejectResponse);
        if (serializedBody) request.write(serializedBody);
        request.end();
      });
    } catch (error) {
      throw new Error(`OpenViking request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`OpenViking returned non-JSON response (${status})`);
    }
    if (status < 200 || status >= 300) {
      const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      const error = envelope?.error && typeof envelope.error === "object"
        ? envelope.error as Record<string, unknown>
        : undefined;
      throw new Error(`OpenViking HTTP ${status}: ${String(error?.message ?? statusText)}`);
    }
    return envelopeResult(payload);
  }
}
