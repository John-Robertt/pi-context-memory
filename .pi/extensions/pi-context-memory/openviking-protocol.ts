import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface OpenVikingResponse<T = unknown> {
  httpStatus: number;
  result: T;
}

export interface NormalizedOpenVikingMessage {
  role: string;
  text: string;
  sourceMessageIds: readonly string[];
}

export interface NormalizedSessionContext {
  overview: string;
  messages: readonly NormalizedOpenVikingMessage[];
  estimatedTokens: number;
}

export function normalizeOpenVikingBaseUrl(value: string): string {
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

export function normalizeOpenVikingEnvelope(value: unknown): unknown {
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

export class OpenVikingHttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, apiKey?: string, timeoutMs = DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS) {
    this.baseUrl = normalizeOpenVikingBaseUrl(baseUrl);
    this.apiKey = apiKey;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("OpenViking request timeout must be a positive integer");
    this.timeoutMs = timeoutMs;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    contentType = "application/json",
  ): Promise<OpenVikingResponse<T>> {
    const serializedBody = body === undefined
      ? undefined
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": contentType };
    if (serializedBody !== undefined) headers["content-length"] = String(serializedBody.length);
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const url = new URL(`${this.baseUrl}${path}`);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const operationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);

    let status = 0;
    let statusText = "";
    let text: string;
    try {
      text = await new Promise<string>((resolveResponse, rejectResponse) => {
        const request = transport(url, { method, headers, signal: operationSignal }, (response) => {
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
      throw new Error(`OpenViking request failed: ${error instanceof Error ? error.message : String(error)}`);
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
    return { httpStatus: status, result: normalizeOpenVikingEnvelope(payload) as T };
  }
}

export function normalizeBatchPendingTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pendingTokens = (value as Record<string, unknown>).pending_tokens;
  return typeof pendingTokens === "number" && Number.isFinite(pendingTokens) && pendingTokens >= 0
    ? pendingTokens
    : undefined;
}

export function normalizeCommitResult(value: unknown):
  | { status: "accepted"; taskId: string }
  | { status: "skipped"; reason?: string } {
  if (!value || typeof value !== "object") throw new Error("OpenViking commit response is invalid");
  const commit = value as Record<string, unknown>;
  if (commit.status === "accepted") {
    if (typeof commit.task_id !== "string" || commit.task_id.length === 0) {
      throw new Error("OpenViking accepted commit response has no task ID");
    }
    return { status: "accepted", taskId: commit.task_id };
  }
  if (commit.status === "skipped") {
    if (commit.task_id !== null && commit.task_id !== undefined) {
      throw new Error("OpenViking skipped commit response unexpectedly has a task ID");
    }
    if (commit.reason !== undefined && typeof commit.reason !== "string") {
      throw new Error("OpenViking skipped commit response has invalid reason");
    }
    return {
      status: "skipped",
      ...(typeof commit.reason === "string" ? { reason: commit.reason } : {}),
    };
  }
  throw new Error(`OpenViking commit response has unknown status ${String(commit.status)}`);
}

export function normalizeTaskState(value: unknown): { status: string; error?: unknown } {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).status !== "string") {
    throw new Error("OpenViking task response is invalid");
  }
  const task = value as Record<string, unknown>;
  return { status: task.status as string, error: task.error };
}

function openVikingMessageText(value: Record<string, unknown>): string {
  if (value.content !== undefined) {
    if (typeof value.content !== "string") throw new Error("OpenViking context message has an unsupported content shape");
    return value.content.trim();
  }
  if (!Array.isArray(value.parts)) throw new Error("OpenViking context message has no supported content");
  const texts: string[] = [];
  for (const part of value.parts) {
    if (!part || typeof part !== "object") throw new Error("OpenViking context message contains an invalid part");
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    else if (item.type === "context" && typeof item.abstract === "string") texts.push(item.abstract);
    else if (item.type === "tool" && typeof item.tool_output === "string") texts.push(item.tool_output);
    else throw new Error(`OpenViking context message contains an unsupported part: ${String(item.type)}`);
  }
  return texts.join("\n").trim();
}

export function isGenericWorkingMemoryFallback(value: string): boolean {
  return /^# Session Summary\s+\*\*Overview\*\*:\s*\d+ turns?,\s*\d+ messages?\s*$/i.test(value.trim());
}

export function normalizeSessionContext(value: unknown): NormalizedSessionContext {
  if (!value || typeof value !== "object") throw new Error("OpenViking context response is invalid");
  const context = value as Record<string, unknown>;
  const overview = context.latest_archive_overview;
  if (overview !== undefined && typeof overview !== "string") {
    throw new Error("OpenViking context response has an invalid Working Memory overview");
  }
  if (!Array.isArray(context.messages)) throw new Error("OpenViking context response has no messages array");
  const normalizedMessages: NormalizedOpenVikingMessage[] = [];
  for (const message of context.messages) {
    if (!message || typeof message !== "object") throw new Error("OpenViking context response contains an invalid message");
    const item = message as Record<string, unknown>;
    const sourceMessageIds = item.source_message_ids;
    if (!Array.isArray(sourceMessageIds)
      || sourceMessageIds.length === 0
      || !sourceMessageIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new Error("OpenViking context response contains invalid source message IDs");
    }
    if (typeof item.role !== "string" || item.role.length === 0) {
      throw new Error("OpenViking context response contains an invalid message role");
    }
    const text = openVikingMessageText(item);
    if (!text) throw new Error("OpenViking context response contains an empty message");
    normalizedMessages.push({
      role: item.role,
      text,
      sourceMessageIds,
    });
  }
  const normalizedOverview = (overview ?? "").trim();
  if (normalizedOverview && isGenericWorkingMemoryFallback(normalizedOverview)) {
    throw new Error("OpenViking returned a generic Working Memory failure fallback");
  }
  if (normalizedMessages.length === 0) {
    throw new Error("OpenViking context response has no source-verifiable active messages");
  }
  const reportedTokens = context.estimatedTokens;
  const estimatedTokens = typeof reportedTokens === "number" && Number.isFinite(reportedTokens) && reportedTokens >= 0
    ? reportedTokens
    : Math.ceil((normalizedOverview.length + normalizedMessages.reduce((total, message) => total + message.text.length, 0)) / 4);
  return { overview: normalizedOverview, messages: normalizedMessages, estimatedTokens };
}
