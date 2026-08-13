import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { SessionIdentity, SourceEntry, SourceRecord } from "./long-term-memory.ts";

const DEFAULT_NAMESPACE = "viking://resources/pi-context-memory";
const MAX_INDEX_CHARS = 64_000;
const SEARCH_PREVIEW_CHARS = 1_200;
const MAX_BACKEND_CANDIDATES = 100;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenViking URL must use HTTP or HTTPS");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const ipv4 = isIP(hostname) === 4 ? hostname.split(".").map(Number) : undefined;
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || (ipv4 !== undefined && ipv4[0] === 127);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Remote OpenViking URLs must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function textOfContent(content: unknown): string {
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

export function sourceText(entry: SourceEntry): string {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    const header = [
      `message_role: ${String(message.role ?? "unknown")}`,
      typeof message.toolName === "string" ? `tool_name: ${message.toolName}` : "",
      typeof message.isError === "boolean" ? `tool_error: ${message.isError}` : "",
    ].filter(Boolean);
    const content = textOfContent(message.content);
    const execution = message.role === "bashExecution"
      ? [`command: ${String(message.command ?? "")}`, `output:\n${String(message.output ?? "")}`].join("\n")
      : "";
    return [...header, content || execution].filter(Boolean).join("\n");
  }
  if (typeof entry.summary === "string") return entry.summary;
  if (entry.type === "custom_message") return textOfContent(entry.content);
  return "";
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
  const body = bounded(sourceText(record.entry), MAX_INDEX_CHARS);
  return [
    "# Pi session source",
    `entry_type: ${record.entry.type}`,
    `timestamp: ${record.entry.timestamp}`,
    "",
    body.content,
    body.truncated ? "\n[index projection truncated]" : "",
  ].filter((line) => line !== "").join("\n");
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

export class OpenVikingSourceRecall {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly namespace: string;
  private readonly inFlight = new Map<string, { contentSha256: string; promise: Promise<void> }>();

  constructor(
    baseUrl = "http://127.0.0.1:1933",
    apiKey?: string,
    timeoutMs = 30_000,
    namespace = DEFAULT_NAMESPACE,
  ) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.apiKey = apiKey;
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

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    contentType = "application/json",
  ): Promise<{ status: number; result: unknown }> {
    const serializedBody = body === undefined
      ? undefined
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": contentType };
    if (serializedBody !== undefined) headers["content-length"] = String(Buffer.byteLength(serializedBody));
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;

    let status = 0;
    let statusText = "";
    let text: string;
    try {
      text = await new Promise<string>((resolveResponse, rejectResponse) => {
        const request = transport(url, {
          method,
          headers,
          signal: this.signal(signal),
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
        if (serializedBody !== undefined) request.write(serializedBody);
        request.end();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenViking request failed: ${message}`);
    }

    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new Error(`OpenViking returned non-JSON response (${status})`);
    }
    if (status < 200 || status >= 300) {
      const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
      const detail = envelope?.error && typeof envelope.error === "object"
        ? String((envelope.error as Record<string, unknown>).message ?? statusText)
        : statusText;
      const error = new Error(`OpenViking HTTP ${status}: ${detail}`) as Error & { status?: number };
      error.status = status;
      throw error;
    }
    return { status, result: envelopeResult(payload) };
  }

  private async readContent(uri: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.request("GET", `/content/read?uri=${encodeURIComponent(uri)}`, undefined, signal);
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
    const response = await this.request(
      "POST",
      "/resources/temp_upload",
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
    const response = await this.request("POST", "/resources", {
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
    const queue = result.queue_status as Record<string, unknown> | undefined;
    const semantic = queue?.Semantic as Record<string, unknown> | undefined;
    const embedding = queue?.Embedding as Record<string, unknown> | undefined;
    if (
      result.status !== "success"
      || result.root_uri !== this.sourceContainerUri(identity, entryId)
      || semantic?.processed !== 0
      || semantic?.error_count !== 0
      || embedding?.error_count !== 0
    ) {
      throw new Error(`OpenViking did not complete vector-only indexing for ${entryId}`);
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
    const backendLimit = Math.min(MAX_BACKEND_CANDIDATES, Math.max(20, limit * 5));
    const response = await this.request("POST", "/search/find", {
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
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<OpenVikingResource>;
      if (typeof candidate.uri !== "string" || typeof candidate.score !== "number" || !Number.isFinite(candidate.score)) continue;
      const source = currentByUri.get(candidate.uri);
      if (!source || seen.has(candidate.uri)) continue;
      seen.add(candidate.uri);
      currentRouteCandidates += 1;
      if (hits.length >= limit) continue;
      const preview = bounded(sourceText(source.entry), SEARCH_PREVIEW_CHARS);
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
