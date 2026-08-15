import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
  type NormalizedOpenVikingMessage,
} from "./openviking-protocol.ts";
import {
  currentUserMessageIndex,
  isOpaqueProviderSegment,
  type MemoryProjection,
} from "./pi-session-protocol.ts";
import {
  OpenVikingSessionMemory,
  type AssembledSessionContext,
  type PreparedSessionMemory,
  type SessionWorkingMemoryOptions,
} from "./session-working-memory.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";

const DEFAULT_MAX_CONTEXT_CHARS = 48_000;
export const DEFAULT_IN_FLIGHT_READY_WAIT_MS = 1_000;

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

/** 本扩展自身责任内的阻断原因；不表示宿主或其它扩展的行为。 */
export type ContextFaultKind =
  | "not-ready"
  | "route"
  | "source-barrier"
  | "tool-protocol"
  | "service"
  | "timeout"
  | "budget"
  | "opaque-content-unrepresentable";

export interface ContextFault {
  kind: ContextFaultKind;
  detail: string;
}

/**
 * 工作上下文构造证明绑定运行代际、路线、leaf、增强内容与一次性 nonce；
 * 完整 Provider 消息序列由 Pi 集成的 PayloadProofAdapter 另行绑定。
 */
export interface AssemblyProof {
  nonce: string;
  generation: string;
  routeFingerprint: string;
  leafId: string | null;
  openVikingSessionId: string;
  enhancedContentHash: string;
}

export type ContextAuthorization<T> =
  | { kind: "allow"; enhancedContext: T[]; proof: AssemblyProof }
  | { kind: "block"; fault: ContextFault };

export interface AuthorizationInput<T> {
  generation: string;
  route: SessionRouteIdentity;
  projections: readonly MemoryProjection[];
  messages: readonly T[];
  readyWaitMs?: number;
  signal?: AbortSignal;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 在任意 Provider payload 结构中核对 nonce 所属的完整增强内容。 */
export function payloadCarriesEnhancedContent(
  value: unknown,
  nonce: string,
  expectedHash: string,
  seen = new Set<unknown>(),
): boolean {
  if (typeof value === "string") return value.includes(nonce) && sha256(value) === expectedHash;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => payloadCarriesEnhancedContent(item, nonce, expectedHash, seen));
  }
  return Object.values(value as Record<string, unknown>)
    .some((item) => payloadCarriesEnhancedContent(item, nonce, expectedHash, seen));
}

/** 把本扩展责任内的失败归类为确定的阻断原因；异常不作为控制流离开授权边界。 */
function classify(error: unknown): ContextFault {
  const detail = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/iu.test(detail)) return { kind: "timeout", detail };
  if (/timed out|timeout|deadline/iu.test(detail)) return { kind: "timeout", detail };
  if (/route|branch|leaf|fingerprint/iu.test(detail)) return { kind: "route", detail };
  if (/source|blob|archive|entry/iu.test(detail)) return { kind: "source-barrier", detail };
  if (/budget|limit|exceeded|character/iu.test(detail)) return { kind: "budget", detail };
  return { kind: "service", detail };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function projectionMessageText(message: NormalizedOpenVikingMessage): string {
  const sourceIds = message.sourceMessageIds.join(",");
  return `[${message.role}${sourceIds ? `; Pi entries ${sourceIds}` : ""}]\n${message.text}`;
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
  const overview = context.overview.trim();
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

function enhancedContent(prepared: PreparedWorkingContext, nonce: string): string {
  return `${prepared.content}\n\n<pi-context-memory-proof nonce="${nonce}" />`;
}
/**
 * 构造增强消息序列。无法定位当前 prompt 或内容为空时返回 undefined，由授权边界转为 block；
 * 任何情况下都不返回原始 Pi messages。
 */
export function buildEnhancedContext<T>(
  messages: readonly T[],
  prepared: PreparedWorkingContext,
  nonce: string,
): T[] | undefined {
  const currentPromptIndex = currentUserMessageIndex(messages);
  if (currentPromptIndex < 0 || !prepared.content) return undefined;
  const enhancedMessage = {
    role: "custom",
    customType: "pi-context-memory",
    content: enhancedContent(prepared, nonce),
    display: false,
    details: {
      routeFingerprint: prepared.route.fingerprint,
      openVikingSessionId: prepared.openVikingSessionId,
      hasWorkingMemory: prepared.hasWorkingMemory,
      nonce,
    },
    timestamp: Date.now(),
  } as T;
  return [enhancedMessage, ...messages.slice(currentPromptIndex)];
}

export class WorkingContextOptimizer {
  private readonly sessionMemory: OpenVikingSessionMemory;
  private readonly maxContextChars: number;

  constructor(
    baseUrl: string,
    apiKey?: string,
    requestTimeoutMs = DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
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

  async waitForReady(
    route: SessionRouteIdentity,
    timeoutMs = DEFAULT_IN_FLIGHT_READY_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<PreparedWorkingContext | undefined> {
    const prepared = await this.sessionMemory.waitForReady(route, timeoutMs, signal);
    return prepared ? this.project(prepared) : undefined;
  }

  async prepare(
    route: SessionRouteIdentity,
    projections: readonly MemoryProjection[],
    signal?: AbortSignal,
  ): Promise<PreparedWorkingContext> {
    const prepared = await this.sessionMemory.prepare(route, projections, signal);
    const result = this.project(prepared);
    if (!result) throw new Error("OpenViking assembled an empty working context");
    return result;
  }

  /**
   * 对一次请求只产生 allow 或 block。任何未准备、来源屏障、服务、超时、
   * 容量或不可信表示的情况都是 block，且不携带原始 Pi messages。
   */
  async authorize<T>(input: AuthorizationInput<T>): Promise<ContextAuthorization<T>> {
    try {
      if (input.projections.some(isOpaqueProviderSegment)) {
        return {
          kind: "block",
          fault: {
            kind: "opaque-content-unrepresentable",
            detail: "The historical route contains Provider-visible content without a lossless memory projection",
          },
        };
      }
      let prepared = this.getReady(input.route);
      if (!prepared) {
        prepared = await this.waitForReady(
          input.route,
          input.readyWaitMs ?? DEFAULT_IN_FLIGHT_READY_WAIT_MS,
          input.signal,
        );
      }
      if (!prepared) {
        return { kind: "block", fault: { kind: "not-ready", detail: "Enhanced memory is not ready for the current route" } };
      }
      if (prepared.route.fingerprint !== input.route.fingerprint) {
        return { kind: "block", fault: { kind: "route", detail: "Prepared memory belongs to another route" } };
      }
      const nonce = randomUUID();
      const enhancedContext = buildEnhancedContext(input.messages, prepared, nonce);
      if (!enhancedContext) {
        return { kind: "block", fault: { kind: "route", detail: "The current prompt boundary is not representable" } };
      }
      return {
        kind: "allow",
        enhancedContext,
        proof: {
          nonce,
          generation: input.generation,
          routeFingerprint: input.route.fingerprint,
          leafId: input.route.leafId,
          openVikingSessionId: prepared.openVikingSessionId,
          enhancedContentHash: sha256(enhancedContent(prepared, nonce)),
        },
      };
    } catch (error) {
      return { kind: "block", fault: classify(error) };
    }
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
      hasWorkingMemory: prepared.context.overview.length > 0,
    };
  }
}
