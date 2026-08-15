import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS,
  type NormalizedOpenVikingMessage,
} from "./openviking-protocol.ts";
import {
  currentUserMessageIndex,
  isOpaqueProviderSegment,
  messageMatchesSourceTask,
  type CurrentTurnToolSources,
  type MemoryProjection,
} from "./pi-session-protocol.ts";
import {
  OpenVikingSessionMemory,
  type AssembledSessionContext,
  type PreparedSessionMemory,
  type SessionWorkingMemoryOptions,
} from "./session-working-memory.ts";
import type { SessionRouteIdentity } from "./session-memory-coordination.ts";
import {
  OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER,
  openAICompletionsToolPayloadUpperBoundBytes,
} from "./provider-payload-proof.ts";

const DEFAULT_MAX_CONTEXT_CHARS = 48_000;
const MIN_WORKING_CONTEXT_CHARS = 256;
const PROVIDER_MESSAGE_SERIALIZATION_FACTOR = 2;
const PROVIDER_FRAMING_TOKEN_RESERVE = 256;
const TRANSPORT_MARGIN_TOKEN_RESERVE = 512;
const PROJECTED_EDGE_CHARS = 160;
export const DEFAULT_IN_FLIGHT_READY_WAIT_MS = 1_000;

export interface ProviderPayloadProfile {
  schemaVersion: 1;
  identity: string;
  provider: string;
  model: string;
  api: string;
  payloadAdapter: typeof OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER;
  baseUrlHash: string;
  compatHash: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  systemPromptHash: string;
  toolsHash: string;
  fixedTokenUpperBound: number;
  messageTokenBudget: number;
  estimator: "utf8-json-bytes-x2";
}

export interface ProviderPayloadProfileInput {
  provider: string;
  model: string;
  api: string;
  baseUrl: string;
  compat: unknown;
  contextWindowTokens: number;
  maxOutputTokens: number;
  systemPrompt: string;
  tools: unknown;
}

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
  providerPayloadProfileId: string;
  currentTurnKey: string;
}

export interface CurrentTurnMetrics {
  rawToolBatches: number;
  projectedToolBatches: number;
  projectedSourceEntryIds: readonly string[];
  providerMessageTokenUpperBound: number;
  providerMessageTokenBudget: number;
}

export type ContextAuthorization<T> =
  | { kind: "allow"; enhancedContext: T[]; proof: AssemblyProof; metrics: CurrentTurnMetrics }
  | { kind: "block"; fault: ContextFault };

export interface AuthorizationInput<T> {
  generation: string;
  route: SessionRouteIdentity;
  projections: readonly MemoryProjection[];
  messages: readonly T[];
  providerPayloadProfile: ProviderPayloadProfile;
  toolSources: CurrentTurnToolSources;
  toProviderMessages(messages: readonly T[]): readonly unknown[];
  ensureSources(entryIds: readonly string[]): Promise<void>;
  readyWaitMs?: number;
  signal?: AbortSignal;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(stable(value)), "utf8");
}

export function createProviderPayloadProfile(input: ProviderPayloadProfileInput): ProviderPayloadProfile {
  if (input.api !== "openai-completions") throw new Error(`No verified Provider payload adapter is available for ${input.api}`);
  for (const [name, value] of [
    ["Context window", input.contextWindowTokens],
    ["Maximum output", input.maxOutputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const systemPromptTokens = Buffer.byteLength(input.systemPrompt, "utf8");
  const toolsTokens = openAICompletionsToolPayloadUpperBoundBytes(input.tools);
  const fixedTokenUpperBound = input.maxOutputTokens
    + systemPromptTokens
    + toolsTokens
    + PROVIDER_FRAMING_TOKEN_RESERVE
    + TRANSPORT_MARGIN_TOKEN_RESERVE;
  const messageTokenBudget = input.contextWindowTokens - fixedTokenUpperBound;
  if (messageTokenBudget < MIN_WORKING_CONTEXT_CHARS) {
    throw new Error("Provider payload budget leaves no room for a bounded enhanced request");
  }
  const identityInput = {
    schemaVersion: 1,
    provider: input.provider,
    model: input.model,
    api: input.api,
    payloadAdapter: OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER,
    baseUrlHash: sha256(input.baseUrl),
    compatHash: sha256(stable(input.compat ?? null)),
    contextWindowTokens: input.contextWindowTokens,
    maxOutputTokens: input.maxOutputTokens,
    systemPromptHash: sha256(input.systemPrompt),
    toolsHash: sha256(stable(input.tools)),
    fixedTokenUpperBound,
    messageTokenBudget,
    estimator: "utf8-json-bytes-x2" as const,
  };
  return { ...identityInput, identity: sha256(identityInput) };
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

interface CurrentTurnUnit<T> {
  kind: "message" | "tool-batch";
  raw: readonly T[];
  projected?: readonly T[];
  sourceEntryIds: readonly string[];
  opaque: boolean;
  projectionFault?: ContextFault;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function contentBlocks(message: unknown): readonly Record<string, unknown>[] | undefined {
  const content = record(message)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content) || !content.every((block) => record(block) && typeof record(block)?.type === "string")) {
    return undefined;
  }
  return content as Record<string, unknown>[];
}

function publicContentProjectable(message: unknown): boolean {
  const blocks = contentBlocks(message);
  return Boolean(blocks?.every((block) => ["text", "toolCall", "thinking"].includes(String(block.type))));
}

function edge(value: string): { head: string; tail: string } {
  if (value.length <= PROJECTED_EDGE_CHARS * 2) return { head: value, tail: "" };
  return { head: value.slice(0, PROJECTED_EDGE_CHARS), tail: value.slice(-PROJECTED_EDGE_CHARS) };
}

function projectionDescriptor(message: Record<string, unknown>, sourceEntryId: string): Record<string, unknown> {
  const taskContent = (contentBlocks(message) ?? []).filter((block) => block.type === "text" || block.type === "toolCall");
  const serialized = JSON.stringify(stable(taskContent));
  const status = Object.fromEntries(["isError", "cancelled", "truncated", "stopReason"]
    .filter((key) => message[key] !== undefined)
    .map((key) => [key, message[key]]));
  return {
    sourceEntryId,
    sha256: sha256(stable(taskContent)),
    sizeBytes: Buffer.byteLength(serialized, "utf8"),
    ...edge(serialized),
    ...(Object.keys(status).length > 0 ? { status } : {}),
  };
}

function projectedToolBatch<T>(
  messages: readonly T[],
  callIds: readonly string[],
  sources: CurrentTurnToolSources,
): { messages?: T[]; sourceEntryIds?: string[]; fault?: ContextFault } {
  const assistant = record(messages[0]);
  if (!assistant) return { fault: { kind: "source-barrier", detail: "Projected assistant source is unavailable" } };
  const callSource = sources.callSources[callIds[0]];
  if (!callSource
    || !callIds.every((id) => sources.callSources[id]?.id === callSource.id)
    || !messageMatchesSourceTask(assistant, callSource)) {
    return { fault: { kind: "source-barrier", detail: "Projected assistant content does not match its authoritative Pi source" } };
  }
  const sourceEntryIds = [callSource.id];
  const assistantDescriptor = projectionDescriptor(assistant, callSource.id);
  const projectedAssistant = {
    ...assistant,
    content: [
      {
        type: "text",
        text: `[pi-context-memory projected tool call]\n${JSON.stringify(assistantDescriptor)}`,
      },
      ...(contentBlocks(assistant) ?? [])
        .filter((block) => block.type === "toolCall")
        .map((block) => ({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: {
            piContextMemoryProjection: {
              sourceEntryId: callSource.id,
              sha256: sha256(stable(block.arguments ?? {})),
              sizeBytes: Buffer.byteLength(JSON.stringify(stable(block.arguments ?? {})), "utf8"),
              ...edge(JSON.stringify(stable(block.arguments ?? {}))),
            },
          },
        })),
    ],
  } as T;

  const projectedResults: T[] = [];
  for (const message of messages.slice(1)) {
    const value = record(message);
    const callId = value?.toolCallId;
    if (!value || typeof callId !== "string") {
      return { fault: { kind: "source-barrier", detail: "Projected tool result source is unavailable" } };
    }
    const resultSource = sources.resultSources[callId];
    if (!resultSource || !messageMatchesSourceTask(value, resultSource)) {
      return { fault: { kind: "source-barrier", detail: `Projected tool result ${callId} does not match its authoritative Pi source` } };
    }
    sourceEntryIds.push(resultSource.id);
    const projected = {
      ...value,
      content: [{
        type: "text",
        text: `[pi-context-memory projected tool result]\n${JSON.stringify(projectionDescriptor(value, resultSource.id))}`,
      }],
    } as Record<string, unknown>;
    delete projected.details;
    projectedResults.push(projected as T);
  }
  return { messages: [projectedAssistant, ...projectedResults], sourceEntryIds };
}

function currentTurnUnits<T>(
  messages: readonly T[],
  sources: CurrentTurnToolSources,
): { units?: CurrentTurnUnit<T>[]; fault?: ContextFault } {
  const currentPromptIndex = currentUserMessageIndex(messages);
  if (currentPromptIndex < 0) return { fault: { kind: "route", detail: "The current prompt boundary is not representable" } };
  const current = messages.slice(currentPromptIndex);
  const units: CurrentTurnUnit<T>[] = [];
  const seenCallIds = new Set<string>();
  let index = 0;
  while (index < current.length) {
    const message = record(current[index]);
    if (!message) return { fault: { kind: "opaque-content-unrepresentable", detail: "Current turn contains an unknown message shape" } };
    const blocks = contentBlocks(message);
    const calls = message.role === "assistant" && blocks
      ? blocks.filter((block) => block.type === "toolCall")
      : [];
    if (calls.length === 0) {
      if (message.role === "toolResult") {
        return { fault: { kind: "tool-protocol", detail: "Current turn contains an orphan tool result" } };
      }
      units.push({
        kind: "message",
        raw: [current[index]],
        sourceEntryIds: [],
        opaque: !publicContentProjectable(message),
      });
      index += 1;
      continue;
    }

    const callIds = calls.map((block) => typeof block.id === "string" ? block.id : "");
    if (callIds.some((id) => id.length === 0)
      || new Set(callIds).size !== callIds.length
      || callIds.some((id) => seenCallIds.has(id) || sources.ambiguousToolIds.includes(id))) {
      return { fault: { kind: "tool-protocol", detail: "Current turn contains malformed or duplicate tool calls" } };
    }
    callIds.forEach((id) => seenCallIds.add(id));
    const pending = new Set(callIds);
    const batch: T[] = [current[index]];
    let cursor = index + 1;
    while (cursor < current.length && pending.size > 0) {
      const result = record(current[cursor]);
      if (result?.role !== "toolResult" || typeof result.toolCallId !== "string") break;
      if (!pending.delete(result.toolCallId)) {
        return { fault: { kind: "tool-protocol", detail: "Current turn contains a duplicate or mismatched tool result" } };
      }
      batch.push(current[cursor]);
      cursor += 1;
    }
    if (pending.size > 0) {
      return { fault: { kind: "tool-protocol", detail: "Current turn contains an incomplete ToolBatch" } };
    }
    const projectable = batch.every(publicContentProjectable);
    const projected = projectable ? projectedToolBatch(batch, callIds, sources) : undefined;
    units.push({
      kind: "tool-batch",
      raw: batch,
      projected: projected?.messages,
      sourceEntryIds: projected?.sourceEntryIds ?? [],
      opaque: !projectable,
      projectionFault: projected?.fault,
    });
    index = cursor;
  }
  return { units };
}

function messageTokenUpperBound(messages: readonly unknown[]): number {
  return serializedBytes(messages) * PROVIDER_MESSAGE_SERIALIZATION_FACTOR;
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
      input.signal?.throwIfAborted();
      let preparedSession = this.sessionMemory.getReady(input.route);
      if (!preparedSession) {
        preparedSession = await this.sessionMemory.waitForReady(
          input.route,
          input.readyWaitMs ?? DEFAULT_IN_FLIGHT_READY_WAIT_MS,
          input.signal,
        );
      }
      if (!preparedSession) {
        return { kind: "block", fault: { kind: "not-ready", detail: "Enhanced memory is not ready for the current route" } };
      }
      if (preparedSession.route.fingerprint !== input.route.fingerprint) {
        return { kind: "block", fault: { kind: "route", detail: "Prepared memory belongs to another route" } };
      }
      const parsed = currentTurnUnits(input.messages, input.toolSources);
      if (parsed.fault || !parsed.units) return { kind: "block", fault: parsed.fault ?? { kind: "route", detail: "Current turn is unavailable" } };
      const toolBatchIndexes = parsed.units
        .map((unit, index) => ({ unit, index }))
        .filter((item) => item.unit.kind === "tool-batch");
      const selected = parsed.units.map((unit) => unit.raw);
      const nonce = randomUUID();
      let fitted = this.fitEnhancedContext(
        preparedSession,
        selected.flat(),
        nonce,
        input.providerPayloadProfile,
        input.toProviderMessages,
      );
      const projectedIndexes = new Set<number>();
      if (!fitted) {
        const candidates = toolBatchIndexes
          .filter(({ unit }) => unit.projected !== undefined)
          .map(({ unit, index }) => ({
            unit,
            index,
            savings: messageTokenUpperBound(input.toProviderMessages(unit.raw))
              - messageTokenUpperBound(input.toProviderMessages(unit.projected!)),
          }))
          .filter((candidate) => candidate.savings > 0)
          .sort((left, right) => left.index - right.index);
        for (const candidate of candidates) {
          selected[candidate.index] = candidate.unit.projected!;
          projectedIndexes.add(candidate.index);
          fitted = this.fitEnhancedContext(
            preparedSession,
            selected.flat(),
            nonce,
            input.providerPayloadProfile,
            input.toProviderMessages,
          );
          if (fitted) break;
        }
      }
      if (!fitted) {
        const projectionFault = parsed.units.find((unit) => unit.projectionFault)?.projectionFault;
        if (projectionFault) return { kind: "block", fault: projectionFault };
        const opaque = parsed.units.some((unit) => unit.opaque)
          || toolBatchIndexes.some(({ unit }) => unit.projected === undefined);
        return {
          kind: "block",
          fault: {
            kind: opaque ? "opaque-content-unrepresentable" : "budget",
            detail: opaque
              ? "Current Provider-visible content cannot be represented within the Provider payload budget"
              : "Current turn and the minimum enhanced history exceed the Provider payload budget",
          },
        };
      }
      const projectedSourceEntryIds = [...new Set([...projectedIndexes]
        .flatMap((index) => parsed.units![index].sourceEntryIds))];
      input.signal?.throwIfAborted();
      if (projectedSourceEntryIds.length > 0) await input.ensureSources(projectedSourceEntryIds);
      input.signal?.throwIfAborted();
      const currentTurnKey = sha256(stable({
        profile: input.providerPayloadProfile.identity,
        messages: parsed.units.flatMap((unit) => unit.raw),
        toolSources: input.toolSources,
      }));
      return {
        kind: "allow",
        enhancedContext: fitted.enhancedContext,
        proof: {
          nonce,
          generation: input.generation,
          routeFingerprint: input.route.fingerprint,
          leafId: input.route.leafId,
          openVikingSessionId: fitted.prepared.openVikingSessionId,
          enhancedContentHash: sha256(enhancedContent(fitted.prepared, nonce)),
          providerPayloadProfileId: input.providerPayloadProfile.identity,
          currentTurnKey,
        },
        metrics: {
          rawToolBatches: toolBatchIndexes.length - projectedIndexes.size,
          projectedToolBatches: projectedIndexes.size,
          projectedSourceEntryIds,
          providerMessageTokenUpperBound: fitted.providerMessageTokenUpperBound,
          providerMessageTokenBudget: input.providerPayloadProfile.messageTokenBudget,
        },
      };
    } catch (error) {
      return { kind: "block", fault: classify(error) };
    }
  }

  async shutdown(reason?: unknown): Promise<void> {
    await this.sessionMemory.shutdown(reason);
  }

  private fitEnhancedContext<T>(
    prepared: PreparedSessionMemory,
    currentTurn: readonly T[],
    nonce: string,
    profile: ProviderPayloadProfile,
    toProviderMessages: (messages: readonly T[]) => readonly unknown[],
  ): { prepared: PreparedWorkingContext; enhancedContext: T[]; providerMessageTokenUpperBound: number } | undefined {
    let low = MIN_WORKING_CONTEXT_CHARS;
    let high = this.maxContextChars;
    let best: { prepared: PreparedWorkingContext; enhancedContext: T[]; providerMessageTokenUpperBound: number } | undefined;
    while (low <= high) {
      const maxChars = Math.floor((low + high) / 2);
      const projected = this.project(prepared, maxChars);
      if (!projected) return undefined;
      const enhancedContext = buildEnhancedContext(currentTurn, projected, nonce);
      if (!enhancedContext) return undefined;
      const providerMessageTokenUpperBound = messageTokenUpperBound(toProviderMessages(enhancedContext));
      if (providerMessageTokenUpperBound <= profile.messageTokenBudget) {
        best = { prepared: projected, enhancedContext, providerMessageTokenUpperBound };
        low = maxChars + 1;
      } else {
        high = maxChars - 1;
      }
    }
    return best;
  }

  private project(
    prepared: PreparedSessionMemory,
    maxChars = this.maxContextChars,
  ): PreparedWorkingContext | undefined {
    const content = formatWorkingContext(prepared.route, prepared.context, maxChars);
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
