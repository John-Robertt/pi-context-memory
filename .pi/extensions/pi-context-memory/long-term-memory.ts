import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const SCHEMA_VERSION = 1;
export const DEFAULT_ARCHIVE_COPY_TIMEOUT_MS = 5_000;

export interface SessionIdentity {
  sessionId: string;
  sessionFile: string;
}

export interface SourceEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SourceRecord {
  schemaVersion: 1;
  source: SessionIdentity & { entryId: string };
  entrySha256: string;
  entry: SourceEntry;
}

export interface LargeResultRecord {
  schemaVersion: 1;
  source: SessionIdentity & { entryId: string };
  toolCallId: string;
  bytes: number;
  sha256: string;
  blob: string;
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

function assertSourceRecord(value: unknown, identity: SessionIdentity, entryId: string): SourceRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid source record");
  const record = value as SourceRecord;
  const serializedEntry = JSON.stringify(record.entry);
  if (
    record.schemaVersion !== SCHEMA_VERSION
    || !isIdentity(record.source, identity)
    || record.source.entryId !== entryId
    || !record.entry
    || record.entry.id !== entryId
    || record.entrySha256 !== sha256(serializedEntry)
  ) {
    throw new Error(`Source record identity or integrity mismatch for entry ${entryId}`);
  }
  return record;
}

export class FileLongTermMemory {
  private readonly root: string;
  private readonly copyTimeoutMs: number;

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

  private largeResultMetadataPath(sessionId: string, entryId: string): string {
    return join(this.sessionDirectory(sessionId), "large-results", "records", `${storageKey(entryId)}.json`);
  }

  private largeResultBlobDirectory(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), "large-results", "blobs");
  }

  private async ensureSession(identity: SessionIdentity): Promise<void> {
    if (!identity.sessionId || !identity.sessionFile) throw new Error("A persisted Pi session identity is required");
    const sessionDirectory = this.sessionDirectory(identity.sessionId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = join(sessionDirectory, "session.json");
    const existing = await readJsonIfExists(manifestPath);
    if (existing !== undefined) {
      if (!isIdentity(existing, identity)) throw new Error(`Session archive identity mismatch for ${identity.sessionId}`);
      return;
    }
    await atomicWrite(manifestPath, json({ schemaVersion: SCHEMA_VERSION, ...identity }));
  }

  async archiveSources(identity: SessionIdentity, entries: readonly SourceEntry[]): Promise<void> {
    await this.ensureSession(identity);
    for (const entry of entries) {
      const serializedEntry = JSON.stringify(entry);
      const record: SourceRecord = {
        schemaVersion: SCHEMA_VERSION,
        source: { ...identity, entryId: entry.id },
        entrySha256: sha256(serializedEntry),
        entry,
      };
      const path = this.sourcePath(identity.sessionId, entry.id);
      const existing = await readJsonIfExists(path);
      if (existing !== undefined) {
        const current = assertSourceRecord(existing, identity, entry.id);
        if (current.entrySha256 === record.entrySha256) continue;
      }
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

  async archiveLargeResult(
    identity: SessionIdentity,
    entry: SourceEntry,
    toolCallId: string,
    fullOutputPath: string,
  ): Promise<LargeResultRecord> {
    await this.ensureSession(identity);
    const source = await this.readSource(identity, entry.id);
    if (!source) throw new Error(`Cannot archive a large result without source entry ${entry.id}`);

    const blobDirectory = this.largeResultBlobDirectory(identity.sessionId);
    await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(blobDirectory, `.pending.${randomUUID()}.tmp`);
    const digest = createHash("sha256");
    let bytes = 0;
    const signal = AbortSignal.timeout(this.copyTimeoutMs);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        digest.update(chunk);
        callback(null, chunk);
      },
    });

    let blob: string;
    try {
      await pipeline(
        createReadStream(fullOutputPath, { signal }),
        meter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      blob = `${digest.digest("hex")}.bin`;
      await rename(temporary, join(blobDirectory, blob));
    } finally {
      await rm(temporary, { force: true });
    }

    const record: LargeResultRecord = {
      schemaVersion: SCHEMA_VERSION,
      source: { ...identity, entryId: entry.id },
      toolCallId,
      bytes,
      sha256: blob.slice(0, -4),
      blob,
    };
    await atomicWrite(this.largeResultMetadataPath(identity.sessionId, entry.id), json(record));
    return record;
  }

  async hasLargeResult(identity: SessionIdentity, entryId: string): Promise<boolean> {
    const value = await readJsonIfExists(this.largeResultMetadataPath(identity.sessionId, entryId));
    if (value === undefined) return false;
    const record = value as LargeResultRecord;
    if (
      !record
      || record.schemaVersion !== SCHEMA_VERSION
      || !isIdentity(record.source, identity)
      || record.source.entryId !== entryId
      || typeof record.bytes !== "number"
      || typeof record.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(record.sha256)
      || record.blob !== `${record.sha256}.bin`
      || basename(record.blob) !== record.blob
    ) {
      throw new Error(`Large result identity mismatch for entry ${entryId}`);
    }
    return true;
  }

  async openLargeResult(
    identity: SessionIdentity,
    entryId: string,
  ): Promise<{ record: LargeResultRecord; stream: ReadStream } | undefined> {
    const value = await readJsonIfExists(this.largeResultMetadataPath(identity.sessionId, entryId));
    if (value === undefined) return undefined;
    const record = value as LargeResultRecord;
    if (
      !record
      || record.schemaVersion !== SCHEMA_VERSION
      || !isIdentity(record.source, identity)
      || record.source.entryId !== entryId
      || typeof record.bytes !== "number"
      || typeof record.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(record.sha256)
      || record.blob !== `${record.sha256}.bin`
      || basename(record.blob) !== record.blob
    ) {
      throw new Error(`Large result identity mismatch for entry ${entryId}`);
    }
    const blobPath = join(this.largeResultBlobDirectory(identity.sessionId), record.blob);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(blobPath)) {
      bytes += chunk.length;
      digest.update(chunk);
    }
    if (bytes !== record.bytes || digest.digest("hex") !== record.sha256) {
      throw new Error(`Large result integrity mismatch for entry ${entryId}`);
    }
    return { record, stream: createReadStream(blobPath) };
  }
}
