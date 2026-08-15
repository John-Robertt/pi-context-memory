import { createHash } from "node:crypto";

import {
  FileLongTermMemory,
  isMessageSourceRecord,
  type SessionIdentity,
  type SourceRecord,
} from "./long-term-memory.ts";
import {
  isMessageSource,
  isSourceEntry,
  projectRoute,
  sameMessageSource,
  type MessageSource,
  type PiProtocolProfile,
  type SourceEntry,
} from "./pi-session-protocol.ts";

export const DEFAULT_REQUIRED_SOURCE_INDEX_TIMEOUT_MS = 5_000;
export interface SessionRouteSnapshot extends SessionIdentity {
  leafId: string | null;
  entries: readonly SourceEntry[];
}

export interface SessionRouteIdentity extends SessionIdentity {
  leafId: string | null;
  entryIds: readonly string[];
  fingerprint: string;
}

type SourceIndexRunner = (
  coordinator: SessionMemoryCoordinator,
  snapshot: SessionRouteSnapshot,
  trigger: string,
  signal: AbortSignal,
) => Promise<void>;

interface SourceIndexWaiter {
  settled: boolean;
  signal: AbortSignal;
  timeout: NodeJS.Timeout;
  abortListener: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SourceIndexJob {
  routeKey: string;
  sessionKey: string;
  coordinator: SessionMemoryCoordinator;
  snapshot: SessionRouteSnapshot;
  trigger: string;
  required: boolean;
  started: boolean;
  controller: AbortController;
  waiters: Set<SourceIndexWaiter>;
}

export class SessionSourceIndexCoordinator {
  private readonly run: SourceIndexRunner;
  private readonly shutdownController = new AbortController();
  private readonly queue: SourceIndexJob[] = [];
  private readonly backgroundByRoute = new Map<string, SourceIndexJob>();
  private readonly pendingBackgroundBySession = new Map<string, SourceIndexJob>();
  private readonly pendingRequiredByRoute = new Map<string, SourceIndexJob>();
  private running: SourceIndexJob | undefined;

  constructor(run: SourceIndexRunner) {
    this.run = run;
  }

  private sessionKey(snapshot: SessionRouteSnapshot): string {
    return `${snapshot.sessionId}\0${snapshot.sessionFile}`;
  }

  private routeKey(snapshot: SessionRouteSnapshot): string {
    return `${this.sessionKey(snapshot)}\0${snapshot.leafId ?? ""}`;
  }

  scheduleBackground(
    coordinator: SessionMemoryCoordinator,
    snapshot: SessionRouteSnapshot,
    trigger: string,
  ): void {
    if (this.shutdownController.signal.aborted) return;
    const routeKey = this.routeKey(snapshot);
    const sessionKey = this.sessionKey(snapshot);
    const superseded = this.pendingBackgroundBySession.get(sessionKey);
    if (superseded) {
      const queuedIndex = this.queue.indexOf(superseded);
      if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
      if (this.backgroundByRoute.get(superseded.routeKey) === superseded) {
        this.backgroundByRoute.delete(superseded.routeKey);
      }
      this.pendingBackgroundBySession.delete(sessionKey);
    }
    if (this.backgroundByRoute.has(routeKey)) return;
    const job: SourceIndexJob = {
      routeKey,
      sessionKey,
      coordinator,
      snapshot,
      trigger,
      required: false,
      started: false,
      controller: new AbortController(),
      waiters: new Set(),
    };
    this.backgroundByRoute.set(routeKey, job);
    this.pendingBackgroundBySession.set(sessionKey, job);
    this.queue.push(job);
    this.pump();
  }

  synchronizeAfterInvocation(
    coordinator: SessionMemoryCoordinator,
    snapshot: SessionRouteSnapshot,
    signal: AbortSignal,
    timeoutMs = DEFAULT_REQUIRED_SOURCE_INDEX_TIMEOUT_MS,
  ): Promise<void> {
    if (this.shutdownController.signal.aborted) {
      return Promise.reject(new Error("Session source indexing has stopped"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("Session source indexing timeout must be a positive integer"));
    }
    const routeKey = this.routeKey(snapshot);
    let job = this.pendingRequiredByRoute.get(routeKey);
    if (!job) {
      job = {
        routeKey,
        sessionKey: this.sessionKey(snapshot),
        coordinator,
        snapshot,
        trigger: "recall",
        required: true,
        started: false,
        controller: new AbortController(),
        waiters: new Set(),
      };
      this.pendingRequiredByRoute.set(routeKey, job);
      const firstBackground = this.queue.findIndex((candidate) => !candidate.required);
      if (firstBackground < 0) this.queue.push(job);
      else this.queue.splice(firstBackground, 0, job);
    }
    const completion = this.addWaiter(job, signal, timeoutMs);
    this.pump();
    return completion;
  }

  private addWaiter(job: SourceIndexJob, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter = {} as SourceIndexWaiter;
      waiter.settled = false;
      waiter.signal = signal;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.abortListener = () => this.rejectWaiter(
        job,
        waiter,
        signal.reason instanceof Error ? signal.reason : new Error("Session recall cancelled"),
      );
      waiter.timeout = setTimeout(
        () => this.rejectWaiter(job, waiter, new Error("Session recall index is still being prepared; retry shortly")),
        timeoutMs,
      );
      waiter.timeout.unref();
      job.waiters.add(waiter);
      if (signal.aborted) waiter.abortListener();
      else signal.addEventListener("abort", waiter.abortListener, { once: true });
    });
  }

  private settleWaiter(job: SourceIndexJob, waiter: SourceIndexWaiter, error?: unknown): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timeout);
    waiter.signal.removeEventListener("abort", waiter.abortListener);
    job.waiters.delete(waiter);
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  }

  private rejectWaiter(job: SourceIndexJob, waiter: SourceIndexWaiter, error: unknown): void {
    this.settleWaiter(job, waiter, error);
    if (job.waiters.size > 0) return;
    if (job.started) {
      job.controller.abort(error);
      return;
    }
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    if (this.pendingRequiredByRoute.get(job.routeKey) === job) {
      this.pendingRequiredByRoute.delete(job.routeKey);
    }
  }

  private pump(): void {
    if (this.running || this.shutdownController.signal.aborted) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.required && job.waiters.size === 0) {
      if (this.pendingRequiredByRoute.get(job.routeKey) === job) {
        this.pendingRequiredByRoute.delete(job.routeKey);
      }
      this.pump();
      return;
    }
    job.started = true;
    this.running = job;
    if (job.required && this.pendingRequiredByRoute.get(job.routeKey) === job) {
      this.pendingRequiredByRoute.delete(job.routeKey);
    }
    if (!job.required && this.pendingBackgroundBySession.get(job.sessionKey) === job) {
      this.pendingBackgroundBySession.delete(job.sessionKey);
    }
    const operationSignal = AbortSignal.any([this.shutdownController.signal, job.controller.signal]);
    let operation: Promise<void>;
    try {
      operation = this.run(job.coordinator, job.snapshot, job.trigger, operationSignal);
    } catch (error) {
      operation = Promise.reject(error);
    }
    void operation.then(
      () => {
        for (const waiter of [...job.waiters]) this.settleWaiter(job, waiter);
      },
      (error) => {
        for (const waiter of [...job.waiters]) this.settleWaiter(job, waiter, error);
      },
    ).finally(() => {
      if (this.backgroundByRoute.get(job.routeKey) === job) this.backgroundByRoute.delete(job.routeKey);
      this.running = undefined;
      this.pump();
    });
  }

  shutdown(reason: unknown = new Error("Session source indexing stopped")): void {
    if (this.shutdownController.signal.aborted) return;
    this.shutdownController.abort(reason);
    const running = this.running;
    this.running = undefined;
    if (running) {
      running.controller.abort(reason);
      for (const waiter of [...running.waiters]) this.settleWaiter(running, waiter, reason);
      if (this.backgroundByRoute.get(running.routeKey) === running) {
        this.backgroundByRoute.delete(running.routeKey);
      }
    }
    for (const job of this.queue.splice(0)) {
      for (const waiter of [...job.waiters]) this.settleWaiter(job, waiter, reason);
    }
    this.backgroundByRoute.clear();
    this.pendingBackgroundBySession.clear();
    this.pendingRequiredByRoute.clear();
  }
}

export interface ResolvedSource {
  record: SourceRecord;
  projection: MessageSource;
}


export class SessionMemoryCoordinator {
  private readonly identity: SessionIdentity;
  private readonly memory: FileLongTermMemory;
  private readonly profile: PiProtocolProfile;

  constructor(identity: SessionIdentity, memory: FileLongTermMemory, profile: PiProtocolProfile) {
    if (!identity.sessionId || !identity.sessionFile) throw new Error("A persisted Pi session identity is required");
    this.identity = identity;
    this.memory = memory;
    this.profile = profile;
  }

  /** 当前路线的记忆投影；opaque 段只存在于请求内存，不参与归档。 */
  projectCurrentRoute(snapshot: SessionRouteSnapshot) {
    this.assertCurrentRoute(snapshot);
    return projectRoute(this.profile, snapshot.entries, snapshot.leafId);
  }

  private currentMessageSources(snapshot: SessionRouteSnapshot): Map<string, MessageSource> {
    const sources = new Map<string, MessageSource>();
    for (const projection of this.projectCurrentRoute(snapshot).projections) {
      if (isMessageSource(projection)) sources.set(projection.id, projection);
    }
    return sources;
  }

  assertCurrentRoute(snapshot: SessionRouteSnapshot): void {
    if (
      snapshot.sessionId !== this.identity.sessionId
      || snapshot.sessionFile !== this.identity.sessionFile
    ) {
      throw new Error(`Session identity mismatch: expected ${this.identity.sessionId}`);
    }

    if (snapshot.entries.length === 0) {
      if (snapshot.leafId !== null) throw new Error("An empty route cannot have a leaf");
      return;
    }

    const ids = new Set<string>();
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      const entry = snapshot.entries[index];
      if (!isSourceEntry(entry)) throw new Error(`Invalid source entry at route index ${index}`);
      if (ids.has(entry.id)) throw new Error(`Duplicate source entry ${entry.id}`);
      ids.add(entry.id);
      const expectedParent = index === 0 ? null : snapshot.entries[index - 1].id;
      if (entry.parentId !== expectedParent) {
        throw new Error(`Broken current route at entry ${entry.id}`);
      }
    }

    if (snapshot.entries.at(-1)?.id !== snapshot.leafId) {
      throw new Error(`Current route does not end at leaf ${snapshot.leafId ?? "null"}`);
    }
  }
  identifyCurrentRoute(snapshot: SessionRouteSnapshot): SessionRouteIdentity {
    this.assertCurrentRoute(snapshot);
    return {
      sessionId: snapshot.sessionId,
      sessionFile: snapshot.sessionFile,
      leafId: snapshot.leafId,
      entryIds: snapshot.entries.map((entry) => entry.id),
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ sessionId: snapshot.sessionId, sessionFile: snapshot.sessionFile, entries: snapshot.entries }))
        .digest("hex"),
    };
  }

  /**
   * 归档当前路线：MessageSource 与 ControlBoundary 进入来源，OpaqueProviderSegment 不归档。
   * 完整输出在来源记录存在后复制，并把 fullOutputRef 原子发布进同一份记录。
   */
  async archiveCurrentRoute(
    snapshot: SessionRouteSnapshot,
  ): Promise<{ archivedFullOutputEntryIds: string[] }> {
    const { profileId, projections, fullOutputCandidates } = this.projectCurrentRoute(snapshot);
    await this.memory.archiveSources(this.identity, profileId, projections);

    const archivedFullOutputEntryIds: string[] = [];
    for (const candidate of fullOutputCandidates) {
      if (await this.memory.hasFullOutput(this.identity, candidate.entryId)) {
        if (!await this.memory.ensureFullOutputRecoverable(this.identity, candidate.entryId)) {
          throw new Error(`Full output is not recoverable for entry ${candidate.entryId}`);
        }
        continue;
      }
      await this.memory.archiveFullOutput(this.identity, candidate);
      archivedFullOutputEntryIds.push(candidate.entryId);
    }
    return { archivedFullOutputEntryIds };
  }

  /**
   * 为即将进入 Provider 的投影建立来源屏障。只核对调用方实际省略的 entry，
   * raw ToolBatch 不需要等待来源归档。
   */
  async ensureCurrentSourcesRecoverable(
    snapshot: SessionRouteSnapshot,
    entryIds: readonly string[],
  ): Promise<void> {
    const required = [...new Set(entryIds)];
    if (required.length === 0) return;
    await this.archiveCurrentRoute(snapshot);
    const fullOutputEntryIds = new Set(this.projectCurrentRoute(snapshot).fullOutputCandidates.map((item) => item.entryId));
    for (const entryId of required) {
      const resolved = await this.resolveCurrentSource(snapshot, entryId);
      if (!resolved) throw new Error(`Projected source is unavailable for entry ${entryId}`);
      if (fullOutputEntryIds.has(entryId) && !resolved.record.fullOutputRef) {
        throw new Error(`Projected full output is unavailable for entry ${entryId}`);
      }
    }
  }

  /** 只返回仍属于当前路线、且与当前 Pi entry 重新规范化结果精确一致的来源。 */
  async listCurrentSources(snapshot: SessionRouteSnapshot): Promise<SourceRecord[]> {
    const current = this.currentMessageSources(snapshot);
    const records: SourceRecord[] = [];
    for (const [entryId, projection] of current) {
      const record = await this.memory.readSource(this.identity, entryId);
      if (!record) continue;
      if (!isMessageSourceRecord(record) || !sameMessageSource(record.projection, projection)) {
        throw new Error(`Archived source differs from Pi authority for entry ${entryId}`);
      }
      records.push(record);
    }
    return records;
  }

  async resolveCurrentSource(
    snapshot: SessionRouteSnapshot,
    entryId: string,
  ): Promise<ResolvedSource | undefined> {
    const projection = this.currentMessageSources(snapshot).get(entryId);
    if (!projection) return undefined;
    const record = await this.memory.readSource(this.identity, entryId);
    if (!record) return undefined;
    if (!isMessageSourceRecord(record) || !sameMessageSource(record.projection, projection)) {
      throw new Error(`Archived source differs from Pi authority for entry ${entryId}`);
    }
    return { record, projection };
  }

  async readCurrentFullOutput(
    snapshot: SessionRouteSnapshot,
    entryId: string,
    maxChars: number,
  ) {
    const resolved = await this.resolveCurrentSource(snapshot, entryId);
    if (!resolved?.record.fullOutputRef) return undefined;
    return this.memory.readFullOutputText(this.identity, entryId, maxChars);
  }
}
