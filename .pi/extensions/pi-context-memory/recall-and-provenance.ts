import { createHash, randomUUID } from "node:crypto";

import type { SessionIdentity, SourceEntry, SourceRecord } from "./long-term-memory.ts";
import {
  DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
  OpenVikingHttpClient,
} from "./openviking-protocol.ts";
import { normalizePiEntry } from "./pi-session-protocol.ts";
const DEFAULT_NAMESPACE = "viking://resources/pi-context-memory";
export const RECALL_LIMITS = {
  queryChars: 2_000,
  entryIdChars: 256,
  resultMin: 1,
  resultMax: 10,
  resultDefault: 5,
  expansionMinChars: 1_000,
  expansionMaxChars: 20_000,
  expansionDefaultChars: 8_000,
  sourceIndexChars: 64_000,
  previewChars: 1_200,
  backendCandidates: 100,
} as const;

interface OpenVikingResource {
  uri: string;
  score: number;
}

interface OpenVikingFindResult {
  resources: OpenVikingResource[];
}

export interface RecallHit {
  entryId: string;
  score: number;
  preview: string;
  previewTruncated: boolean;
}

export interface RecallSearchResult {
  hits: RecallHit[];
  backendCandidates: number;
  currentRouteCandidates: number;
}

export interface SourceExpansion {
  entryId: string;
  content: string;
  truncated: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceText(entry: SourceEntry): string {
  return normalizePiEntry(entry).text;
}

function bounded(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  const half = Math.floor((maxChars - 32) / 2);
  return {
    content: `${value.slice(0, half)}\n… content omitted …\n${value.slice(-half)}`,
    truncated: true,
  };
}

function indexedContent(record: SourceRecord): string {
  const body = bounded(sourceText(record.entry), RECALL_LIMITS.sourceIndexChars);
  return [
    "# Pi session source",
    `entry_type: ${record.entry.type}`,
    `timestamp: ${record.entry.timestamp}`,
    "",
    body.content,
    body.truncated ? "\n[index projection truncated]" : "",
  ].filter((line) => line !== "").join("\n");
}
export class OpenVikingSourceRecall {
  private readonly client: OpenVikingHttpClient;
  private readonly timeoutMs: number;
  private readonly namespace: string;
  private readonly inFlight = new Map<string, { contentSha256: string; promise: Promise<void> }>();

  constructor(
    baseUrl: string,
    apiKey?: string,
    timeoutMs = DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
    namespace = DEFAULT_NAMESPACE,
  ) {
    this.client = new OpenVikingHttpClient(baseUrl, apiKey, timeoutMs);
    this.timeoutMs = timeoutMs;
    this.namespace = namespace.replace(/\/$/, "");
  }

  sessionUri(identity: SessionIdentity): string {
    return `${this.namespace}/${sha256(identity.sessionId)}`;
  }

  private sourceContainerUri(identity: SessionIdentity, entryId: string): string {
    return `${this.sessionUri(identity)}/${sha256(entryId).slice(0, 32)}`;
  }

  sourceUri(identity: SessionIdentity, entryId: string): string {
    return `${this.sourceContainerUri(identity, entryId)}/source.md`;
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }


  private async readContent(uri: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.client.request("GET", `/api/v1/content/read?uri=${encodeURIComponent(uri)}`, undefined, signal);
      if (typeof response.result !== "string") throw new Error("OpenViking content read did not return text");
      return response.result;
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) return undefined;
      throw error;
    }
  }

  private async waitForContent(uri: string, expected: string, signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const content = await this.readContent(uri, signal);
      if (content !== undefined) {
        if (content !== expected) throw new Error(`OpenViking source differs after concurrent indexing for ${uri}`);
        return;
      }
      await new Promise<void>((resolveWait, rejectWait) => {
        let timeout: NodeJS.Timeout;
        const finished = () => {
          signal.removeEventListener("abort", aborted);
          resolveWait();
        };
        const aborted = () => {
          clearTimeout(timeout);
          rejectWait(signal.reason instanceof Error ? signal.reason : new Error("OpenViking indexing cancelled"));
        };
        timeout = setTimeout(finished, 50);
        timeout.unref();
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
      });
    }
  }

  private async uploadContent(filename: string, content: string, signal?: AbortSignal): Promise<string> {
    const boundary = `----pi-context-memory-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown; charset=utf-8\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.client.request(
      "POST",
      "/api/v1/resources/temp_upload",
      body,
      signal,
      `multipart/form-data; boundary=${boundary}`,
    );
    if (!response.result || typeof response.result !== "object") {
      throw new Error("OpenViking upload returned an invalid result");
    }
    const tempFileId = (response.result as Record<string, unknown>).temp_file_id;
    if (typeof tempFileId !== "string" || tempFileId.length === 0) {
      throw new Error("OpenViking upload returned no temporary file ID");
    }
    return tempFileId;
  }

  private async addVectorResource(
    identity: SessionIdentity,
    entryId: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const tempFileId = await this.uploadContent("source.md", content, signal);
    const response = await this.client.request("POST", "/api/v1/resources", {
      temp_file_id: tempFileId,
      to: this.sourceContainerUri(identity, entryId),
      processing_mode: "vectors_only",
      wait: true,
      timeout: Math.ceil(this.timeoutMs / 1_000),
      strict: false,
      args: { parse_mode: "no_split" },
    }, signal);
    if (!response.result || typeof response.result !== "object") {
      throw new Error("OpenViking resource add returned an invalid result");
    }
    const result = response.result as Record<string, unknown>;
    if (result.status !== undefined && result.status !== "success") {
      throw new Error(`OpenViking resource add failed for ${entryId}`);
    }
    if (result.root_uri !== undefined && result.root_uri !== this.sourceContainerUri(identity, entryId)) {
      throw new Error(`OpenViking resource add returned the wrong root URI for ${entryId}`);
    }
  }

  private ensureSource(record: SourceRecord, signal?: AbortSignal): Promise<void> {
    const uri = this.sourceUri(record.source, record.source.entryId);
    const content = indexedContent(record);
    const contentSha256 = sha256(content);
    const existing = this.inFlight.get(uri);
    if (existing) {
      if (existing.contentSha256 !== contentSha256) {
        return Promise.reject(new Error(`Concurrent OpenViking source differs from immutable Pi entry ${record.source.entryId}`));
      }
      return existing.promise;
    }

    const operationSignal = this.signal(signal);
    const operation = (async () => {
      const current = await this.readContent(uri, operationSignal);
      if (current !== undefined && current !== content) {
        throw new Error(`OpenViking source differs from immutable Pi entry ${record.source.entryId}`);
      }
      if (current === undefined) {
        try {
          await this.addVectorResource(record.source, record.source.entryId, content, operationSignal);
        } catch (error) {
          if ((error as Error & { status?: number }).status !== 409) throw error;
          await this.waitForContent(uri, content, operationSignal);
        }
        const indexed = await this.readContent(uri, operationSignal);
        if (indexed !== content) throw new Error(`OpenViking did not preserve source URI ${uri}`);
      }
    })().finally(() => this.inFlight.delete(uri));
    this.inFlight.set(uri, { contentSha256, promise: operation });
    return operation;
  }

  async synchronize(records: readonly SourceRecord[], signal?: AbortSignal): Promise<void> {
    const errors: string[] = [];
    for (const record of records) {
      signal?.throwIfAborted();
      if (sourceText(record.entry).trim().length === 0) continue;
      try {
        await this.ensureSource(record, signal);
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${record.source.entryId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length > 0) throw new Error(`OpenViking indexing failed (${errors.join("; ")})`);
  }

  async searchCurrent(
    identity: SessionIdentity,
    currentSources: readonly SourceRecord[],
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RecallSearchResult> {
    const currentByUri = new Map(
      currentSources
        .filter((record) => sourceText(record.entry).trim().length > 0)
        .map((record) => [this.sourceUri(identity, record.source.entryId), record] as const),
    );
    if (currentByUri.size === 0) {
      return { hits: [], backendCandidates: 0, currentRouteCandidates: 0 };
    }
    const backendLimit = Math.min(
      RECALL_LIMITS.backendCandidates,
      Math.max(RECALL_LIMITS.resultMax * 2, limit * 5),
    );
    const response = await this.client.request("POST", "/api/v1/search/find", {
      query,
      target_uri: [...currentByUri.keys()],
      context_type: ["resource"],
      limit: backendLimit,
    }, signal);
    if (!response.result || typeof response.result !== "object") {
      throw new Error("OpenViking search returned an invalid result");
    }
    const result = response.result as Partial<OpenVikingFindResult>;
    if (!Array.isArray(result.resources)) throw new Error("OpenViking search result has no resources array");

    const seen = new Set<string>();
    const hits: RecallHit[] = [];
    let currentRouteCandidates = 0;
    for (const value of result.resources) {
      if (!value || typeof value !== "object") {
        throw new Error("OpenViking search returned an invalid resource candidate");
      }
      const candidate = value as Partial<OpenVikingResource>;
      if (typeof candidate.uri !== "string" || typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) {
        throw new Error("OpenViking search returned an invalid resource candidate");
      }
      const source = currentByUri.get(candidate.uri);
      if (!source || seen.has(candidate.uri)) continue;
      seen.add(candidate.uri);
      currentRouteCandidates += 1;
      if (hits.length >= limit) continue;
      const preview = bounded(sourceText(source.entry), RECALL_LIMITS.previewChars);
      hits.push({
        entryId: source.source.entryId,
        score: candidate.score,
        preview: preview.content,
        previewTruncated: preview.truncated,
      });
    }
    return {
      hits,
      backendCandidates: result.resources.length,
      currentRouteCandidates,
    };
  }
}

export function expandSource(entry: SourceEntry, maxChars: number): SourceExpansion {
  const content = bounded(JSON.stringify(entry, null, 2), maxChars);
  return { entryId: entry.id, content: content.content, truncated: content.truncated };
}

export function formatSearchResult(result: RecallSearchResult): string {
  if (result.hits.length === 0) {
    return `No current-branch sources matched. OpenViking returned ${result.backendCandidates} candidates; ${result.currentRouteCandidates} belonged to the current route.`;
  }
  const sections = result.hits.map((hit, index) => [
    `## ${index + 1}. entry ${hit.entryId}`,
    `score: ${hit.score.toFixed(4)}`,
    hit.previewTruncated ? "preview_truncated: true" : "preview_truncated: false",
    "",
    hit.preview,
  ].join("\n"));
  return [
    `Found ${result.hits.length} current-branch sources (${result.backendCandidates} backend candidates; ${result.currentRouteCandidates} current-route candidates).`,
    "Use recall_session with action=read_source and an entry_id to expand a source.",
    "",
    ...sections,
  ].join("\n");
}
