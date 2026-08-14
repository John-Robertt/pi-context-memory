import { createHash } from "node:crypto";

import {
  FileLongTermMemory,
  type SessionIdentity,
  type SourceEntry,
  type SourceRecord,
} from "./long-term-memory.ts";
import { isSourceEntry, largeResultOf } from "./pi-session-protocol.ts";

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
    timeoutMs = 5_000,
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
  authoritativeEntry: SourceEntry;
}


export class SessionMemoryCoordinator {
  private readonly identity: SessionIdentity;
  private readonly memory: FileLongTermMemory;
  private archivedSourceIds: Promise<Set<string>> | undefined;

  constructor(identity: SessionIdentity, memory: FileLongTermMemory) {
    if (!identity.sessionId || !identity.sessionFile) throw new Error("A persisted Pi session identity is required");
    this.identity = identity;
    this.memory = memory;
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

  private knownSourceIds(): Promise<Set<string>> {
    this.archivedSourceIds ??= this.memory.listSources(this.identity).then(
      (records) => new Set(records.map((record) => record.source.entryId)),
    );
    return this.archivedSourceIds;
  }

  async archiveCurrentRoute(
    snapshot: SessionRouteSnapshot,
  ): Promise<{ archivedToolCallIds: string[] }> {
    this.assertCurrentRoute(snapshot);
    const archivedSourceIds = await this.knownSourceIds();
    const missingEntries = snapshot.entries.filter((entry) => !archivedSourceIds.has(entry.id));
    if (missingEntries.length > 0) {
      await this.memory.archiveSources(this.identity, missingEntries);
      for (const entry of missingEntries) archivedSourceIds.add(entry.id);
    }

    const archivedToolCallIds: string[] = [];
    for (const entry of snapshot.entries) {
      const largeResult = largeResultOf(entry);
      if (!largeResult) continue;
      if (await this.memory.hasLargeResult(this.identity, entry.id)) continue;
      await this.memory.archiveLargeResult(
        this.identity,
        entry,
        largeResult.toolCallId,
        largeResult.fullOutputPath,
      );
      archivedToolCallIds.push(largeResult.toolCallId);
    }
    return { archivedToolCallIds };
  }

  async listCurrentSources(snapshot: SessionRouteSnapshot): Promise<SourceRecord[]> {
    this.assertCurrentRoute(snapshot);
    const records: SourceRecord[] = [];
    for (const entry of snapshot.entries) {
      const record = await this.memory.readSource(this.identity, entry.id);
      if (!record) continue;
      if (JSON.stringify(record.entry) !== JSON.stringify(entry)) {
        throw new Error(`Archived source differs from Pi authority for entry ${entry.id}`);
      }
      records.push(record);
    }
    return records;
  }

  async resolveCurrentSource(
    snapshot: SessionRouteSnapshot,
    entryId: string,
  ): Promise<ResolvedSource | undefined> {
    this.assertCurrentRoute(snapshot);
    const authoritativeEntry = snapshot.entries.find((entry) => entry.id === entryId);
    if (!authoritativeEntry) return undefined;
    const record = await this.memory.readSource(this.identity, entryId);
    if (!record) return undefined;
    if (JSON.stringify(record.entry) !== JSON.stringify(authoritativeEntry)) {
      throw new Error(`Archived source differs from Pi authority for entry ${entryId}`);
    }
    return { record, authoritativeEntry };
  }
}
