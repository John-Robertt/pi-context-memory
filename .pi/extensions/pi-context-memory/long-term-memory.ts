import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  ControlBoundary,
  FullOutputCandidate,
  MemoryProjection,
  MessageSource,
} from "./pi-session-protocol.ts";

/**
 * 归档格式身份。来源是派生数据，Pi session entry 是事实权威，因此不读取其它格式：
 * 身份不一致的归档目录整体丢弃后从当前 branch 重建。
 */
const ARCHIVE_FORMAT = "message-source-v1";
export const DEFAULT_ARCHIVE_COPY_TIMEOUT_MS = 5_000;

export interface SessionIdentity {
  sessionId: string;
  sessionFile: string;
}

export interface FullOutputRef {
  blobId: string;
  sha256: string;
  size: number;
}

export interface MessageSourceRecord {
  format: typeof ARCHIVE_FORMAT;
  normalizationVersion: string;
  source: SessionIdentity & { entryId: string };
  projection: MessageSource;
  fullOutputRef?: FullOutputRef;
}

export interface ControlBoundaryRecord {
  format: typeof ARCHIVE_FORMAT;
  normalizationVersion: string;
  source: SessionIdentity & { entryId: string };
  projection: ControlBoundary;
}

export type SourceRecord = MessageSourceRecord | ControlBoundaryRecord;

export function isMessageSourceRecord(record: SourceRecord): record is MessageSourceRecord {
  return record.projection.kind === "message-source";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function storageKey(value: string): string {
  return sha256(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isIdentity(value: unknown, expected: SessionIdentity): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return identity.sessionId === expected.sessionId && identity.sessionFile === expected.sessionFile;
}

function isFullOutputRef(value: unknown): value is FullOutputRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(ref.sha256)
    && ref.blobId === `${ref.sha256}.bin`
    && basename(ref.blobId) === ref.blobId
    && typeof ref.size === "number"
    && Number.isSafeInteger(ref.size)
    && ref.size >= 0;
}

/**
 * 记录损坏与「不属于当前格式」是两种语义：前者在此抛出故障，后者由 ensureSession 丢弃重建。
 */
function assertSourceRecord(value: unknown, identity: SessionIdentity, entryId: string): SourceRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid source record");
  const record = value as SourceRecord;
  const projection = record.projection as MemoryProjection | undefined;
  if (
    record.format !== ARCHIVE_FORMAT
    || typeof record.normalizationVersion !== "string"
    || !isIdentity(record.source, identity)
    || record.source.entryId !== entryId
    || !projection
    || (projection.kind !== "message-source" && projection.kind !== "control-boundary")
    || projection.id !== entryId
  ) {
    throw new Error(`Source record identity or integrity mismatch for entry ${entryId}`);
  }
  if (projection.kind === "message-source") {
    const rebuilt = sha256(JSON.stringify({
      taskContent: projection.taskContent,
      completion: projection.completion,
    }));
    if (rebuilt !== projection.taskContentHash) {
      throw new Error(`Source record task content hash mismatch for entry ${entryId}`);
    }
    const ref = (record as MessageSourceRecord).fullOutputRef;
    if (ref !== undefined && !isFullOutputRef(ref)) {
      throw new Error(`Source record full output reference mismatch for entry ${entryId}`);
    }
  }
  return record;
}

export class FileLongTermMemory {
  private readonly root: string;
  private readonly copyTimeoutMs: number;
  private readonly preparedSessions = new Set<string>();

  constructor(root: string, copyTimeoutMs = DEFAULT_ARCHIVE_COPY_TIMEOUT_MS) {
    this.root = root;
    this.copyTimeoutMs = copyTimeoutMs;
  }

  private sessionDirectory(sessionId: string): string {
    return join(this.root, storageKey(sessionId));
  }

  private sourcePath(sessionId: string, entryId: string): string {
    return join(this.sessionDirectory(sessionId), "sources", `${storageKey(entryId)}.json`);
  }

  private blobDirectory(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), "large-results", "blobs");
  }

  /** 归档格式身份不匹配时丢弃整个 session 归档目录并重建；不存在读取其它格式的路径。 */
  private async ensureSession(identity: SessionIdentity): Promise<void> {
    if (!identity.sessionId || !identity.sessionFile) throw new Error("A persisted Pi session identity is required");
    const sessionDirectory = this.sessionDirectory(identity.sessionId);
    if (this.preparedSessions.has(sessionDirectory)) return;
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = join(sessionDirectory, "session.json");
    const existing = await readJsonIfExists(manifestPath);
    if (existing !== undefined) {
      const manifest = existing as Record<string, unknown>;
      if (manifest.format === ARCHIVE_FORMAT) {
        if (!isIdentity(manifest, identity)) throw new Error(`Session archive identity mismatch for ${identity.sessionId}`);
        this.preparedSessions.add(sessionDirectory);
        return;
      }
      await rm(sessionDirectory, { recursive: true, force: true });
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    }
    await atomicWrite(manifestPath, json({ format: ARCHIVE_FORMAT, ...identity }));
    this.preparedSessions.add(sessionDirectory);
  }

  /**
   * 幂等保存当前路线投影。同一 entry ID 出现不同投影内容表示归档时序或记录完整性被破坏，
   * 属于故障而非补齐：来源只在最终化后提交。
   */
  async archiveSources(
    identity: SessionIdentity,
    normalizationVersion: string,
    projections: readonly MemoryProjection[],
  ): Promise<void> {
    await this.ensureSession(identity);
    for (const projection of projections) {
      if (projection.kind === "opaque-provider-segment") continue;
      const path = this.sourcePath(identity.sessionId, projection.id);
      const existing = await readJsonIfExists(path);
      if (existing !== undefined) {
        const current = assertSourceRecord(existing, identity, projection.id);
        if (JSON.stringify(current.projection) === JSON.stringify(projection)) continue;
        throw new Error(`Archived source differs from the current projection for entry ${projection.id}`);
      }
      const record: SourceRecord = {
        format: ARCHIVE_FORMAT,
        normalizationVersion,
        source: { ...identity, entryId: projection.id },
        projection,
      } as SourceRecord;
      await atomicWrite(path, json(record));
    }
  }

  async readSource(identity: SessionIdentity, entryId: string): Promise<SourceRecord | undefined> {
    const value = await readJsonIfExists(this.sourcePath(identity.sessionId, entryId));
    return value === undefined ? undefined : assertSourceRecord(value, identity, entryId);
  }

  async listSources(identity: SessionIdentity): Promise<SourceRecord[]> {
    const sourceDirectory = join(this.sessionDirectory(identity.sessionId), "sources");
    let names: string[];
    try {
      names = await readdir(sourceDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: SourceRecord[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const value = await readJsonIfExists(join(sourceDirectory, name));
      if (!value || typeof value !== "object") throw new Error(`Invalid source record file ${name}`);
      const entryId = (value as SourceRecord).source?.entryId;
      if (typeof entryId !== "string") throw new Error(`Missing source entry identity in ${name}`);
      records.push(assertSourceRecord(value, identity, entryId));
    }
    return records;
  }

  /**
   * 复制完整工具输出并在 blob 完整写入后，把 fullOutputRef 原子发布进同一份来源记录。
   * 候选路径只在复制期间存在，不写入任何记录。
   */
  async archiveFullOutput(
    identity: SessionIdentity,
    candidate: FullOutputCandidate,
  ): Promise<FullOutputRef> {
    await this.ensureSession(identity);
    const existing = await this.readSource(identity, candidate.entryId);
    if (!existing) throw new Error(`Cannot archive a full output without source entry ${candidate.entryId}`);
    if (!isMessageSourceRecord(existing)) {
      throw new Error(`Only a message source can carry a full output reference: ${candidate.entryId}`);
    }

    const blobDirectory = this.blobDirectory(identity.sessionId);
    await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(blobDirectory, `.pending.${randomUUID()}.tmp`);
    const digest = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        digest.update(chunk);
        callback(null, chunk);
      },
    });

    // pipeline 独占取消与流清理；单独的 stream 不再注册第二套 signal/error 生命周期。
    const input = createReadStream(candidate.path);
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const controller = new AbortController();
    const deadlineReason = new Error(`Full output copy exceeded ${this.copyTimeoutMs}ms for entry ${candidate.entryId}`);
    const deadline = setTimeout(() => controller.abort(deadlineReason), this.copyTimeoutMs);
    deadline.unref();

    let blobId: string;
    let contentSha256: string;
    try {
      await pipeline(input, meter, output, { signal: controller.signal });
      contentSha256 = digest.digest("hex");
      blobId = `${contentSha256}.bin`;
      await rename(temporary, join(blobDirectory, blobId));
    } catch (error) {
      if (controller.signal.aborted) throw deadlineReason;
      throw error;
    } finally {
      clearTimeout(deadline);
      await rm(temporary, { force: true });
    }

    const fullOutputRef: FullOutputRef = { blobId, sha256: contentSha256, size };
    await atomicWrite(
      this.sourcePath(identity.sessionId, candidate.entryId),
      json({ ...existing, fullOutputRef } satisfies MessageSourceRecord),
    );
    return fullOutputRef;
  }

  async hasFullOutput(identity: SessionIdentity, entryId: string): Promise<boolean> {
    const record = await this.readSource(identity, entryId);
    return Boolean(record && isMessageSourceRecord(record) && record.fullOutputRef);
  }

  /** 读取时重验大小与 SHA-256；不一致的记录不作为可恢复来源。 */
  async openFullOutput(
    identity: SessionIdentity,
    entryId: string,
  ): Promise<{ ref: FullOutputRef; stream: ReadStream } | undefined> {
    const record = await this.readSource(identity, entryId);
    if (!record || !isMessageSourceRecord(record) || !record.fullOutputRef) return undefined;
    const ref = record.fullOutputRef;
    const blobPath = join(this.blobDirectory(identity.sessionId), ref.blobId);
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(blobPath)) {
      size += chunk.length;
      digest.update(chunk);
    }
    if (size !== ref.size || digest.digest("hex") !== ref.sha256) {
      throw new Error(`Full output integrity mismatch for entry ${entryId}`);
    }
    return { ref, stream: createReadStream(blobPath) };
  }

  async ensureFullOutputRecoverable(identity: SessionIdentity, entryId: string): Promise<boolean> {
    const opened = await this.openFullOutput(identity, entryId);
    if (!opened) return false;
    opened.stream.destroy();
    return true;
  }

  async readFullOutputText(
    identity: SessionIdentity,
    entryId: string,
    maxChars: number,
  ): Promise<{ ref: FullOutputRef; content: string; truncated: boolean } | undefined> {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new Error("Full output character limit must be a positive integer");
    }
    const opened = await this.openFullOutput(identity, entryId);
    if (!opened) return undefined;

    const decoder = new TextDecoder();
    let content = "";
    let truncated = false;
    for await (const chunk of opened.stream) {
      content += decoder.decode(chunk, { stream: true });
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
        break;
      }
    }
    if (!truncated) content += decoder.decode();
    return { ref: opened.ref, content, truncated };
  }
}
