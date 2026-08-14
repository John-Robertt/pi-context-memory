import type { SourceEntry } from "./long-term-memory.ts";
import {
  OpenVikingSessionMemory,
  type AssembledSessionContext,
  type PreparedSessionMemory,
  type SessionWorkingMemoryOptions,
} from "./session-working-memory.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";

const DEFAULT_MAX_CONTEXT_CHARS = 48_000;

export interface WorkingContextOptions extends SessionWorkingMemoryOptions {
  maxContextChars?: number;
}

export interface PreparedWorkingContext {
  route: SessionRouteIdentity;
  openVikingSessionId: string;
  content: string;
  estimatedTokens: number;
  hasWorkingMemory: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function projectionSources(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const sourceIds = (message as Record<string, unknown>).source_message_ids;
  return Array.isArray(sourceIds)
    ? sourceIds.filter((value): value is string => typeof value === "string").join(",")
    : "";
}

function projectionMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as Record<string, unknown>;
  const role = typeof value.role === "string" ? value.role : "unknown";
  const parts = Array.isArray(value.parts) ? value.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    if (item.type === "context" && typeof item.abstract === "string") texts.push(item.abstract);
    if (item.type === "tool" && typeof item.tool_output === "string") texts.push(item.tool_output);
  }
  const sourceIds = projectionSources(value);
  const body = texts.join("\n").trim();
  return body ? `[${role}${sourceIds ? `; Pi entries ${sourceIds}` : ""}]\n${body}` : "";
}

function boundedMiddle(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const marker = "\n… content omitted …\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const half = Math.floor((maxChars - marker.length) / 2);
  return `${value.slice(0, half)}${marker}${value.slice(-(maxChars - marker.length - half))}`;
}

export function formatWorkingContext(
  route: SessionRouteIdentity,
  context: AssembledSessionContext,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new Error("Context character limit must be at least 256");
  const overview = context.latestArchiveOverview.trim();
  const active = context.messages.map(projectionMessageText).filter(Boolean).join("\n\n");
  if (!overview && !active) return "";
  let result = [
    "# Enhanced session context",
    `Pi history leaf: ${route.leafId ?? "root"}`,
    "This is a bounded derivative of the current Pi route. Use recall_session to verify critical source details.",
  ].join("\n");
  const overviewPrefix = "\n\n## Working memory\n";
  const activePrefix = "\n\n## Active history\n";
  const appendSection = (prefix: string, content: string, fromTail: boolean, cap = Number.POSITIVE_INFINITY) => {
    const allowance = Math.min(cap, maxChars - result.length - prefix.length);
    if (!content || allowance <= 0) return;
    const selected = fromTail
      ? content.length <= allowance ? content : content.slice(-allowance)
      : boundedMiddle(content, allowance);
    result += `${prefix}${selected}`;
  };
  const overviewCap = active
    ? Math.max(0, Math.floor((maxChars - result.length - overviewPrefix.length - activePrefix.length) / 2))
    : Number.POSITIVE_INFINITY;
  appendSection(overviewPrefix, overview, false, Math.min(24_000, overviewCap));
  appendSection(activePrefix, active, true);
  if (result.length > maxChars) throw new Error("Working context exceeded its character limit");
  return result;
}

export function applyPreparedWorkingContext<T>(messages: readonly T[], prepared: PreparedWorkingContext): T[] {
  let currentPromptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown;
    if (message && typeof message === "object" && (message as Record<string, unknown>).role === "user") {
      currentPromptIndex = index;
      break;
    }
  }
  if (currentPromptIndex < 0 || !prepared.content) return [...messages];
  const enhancedMessage = {
    role: "custom",
    customType: "pi-context-memory",
    content: prepared.content,
    display: false,
    details: {
      routeFingerprint: prepared.route.fingerprint,
      openVikingSessionId: prepared.openVikingSessionId,
      hasWorkingMemory: prepared.hasWorkingMemory,
    },
    timestamp: Date.now(),
  } as T;
  return [enhancedMessage, ...messages.slice(currentPromptIndex)];
}

export class WorkingContextOptimizer {
  private readonly sessionMemory: OpenVikingSessionMemory;
  private readonly maxContextChars: number;

  constructor(
    baseUrl = "http://127.0.0.1:1933",
    apiKey?: string,
    requestTimeoutMs = 30_000,
    options: WorkingContextOptions = {},
  ) {
    this.maxContextChars = positiveInteger(options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, "Context character limit");
    if (this.maxContextChars < 256) throw new Error("Context character limit must be at least 256");
    this.sessionMemory = new OpenVikingSessionMemory(baseUrl, apiKey, requestTimeoutMs, options);
  }

  getReady(route: SessionRouteIdentity): PreparedWorkingContext | undefined {
    const prepared = this.sessionMemory.getReady(route);
    return prepared ? this.project(prepared) : undefined;
  }

  async prepare(
    route: SessionRouteIdentity,
    entries: readonly SourceEntry[],
    signal?: AbortSignal,
  ): Promise<PreparedWorkingContext> {
    const prepared = await this.sessionMemory.prepare(route, entries, signal);
    const result = this.project(prepared);
    if (!result) throw new Error("OpenViking assembled an empty working context");
    return result;
  }

  async shutdown(reason?: unknown): Promise<void> {
    await this.sessionMemory.shutdown(reason);
  }

  private project(prepared: PreparedSessionMemory): PreparedWorkingContext | undefined {
    const content = formatWorkingContext(prepared.route, prepared.context, this.maxContextChars);
    if (!content) return undefined;
    return {
      route: prepared.route,
      openVikingSessionId: prepared.openVikingSessionId,
      content,
      estimatedTokens: prepared.context.estimatedTokens,
      hasWorkingMemory: prepared.context.latestArchiveOverview.trim().length > 0,
    };
  }
}
