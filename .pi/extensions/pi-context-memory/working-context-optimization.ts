import { createHash, randomUUID } from "node:crypto";

import {
  currentUserMessageIndex,
  messageMatchesSourceTask,
  type CurrentTurnToolSources,
} from "./pi-session-protocol.ts";
import {
  projectMemorySources,
  type MemoryCheckpoint,
  type RetentionPolicy,
} from "./session-working-memory.ts";
import type {
  ResolvedHistoricalContext,
  SessionRouteIdentity,
  VerifiedActiveDelta,
} from "./session-memory-coordination.ts";
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

export interface WorkingContextOptions {
  maxContextChars?: number;
}

export interface PreparedWorkingContext {
  route: SessionRouteIdentity;
  checkpointIdentity: string;
  retentionBudgetIdentity: string;
  deltaHash: string;
  openVikingSessionId: string | null;
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
  | "checkpoint-refresh-required"
  | "opaque-content-unrepresentable";

export interface ContextFault {
  kind: ContextFaultKind;
  detail: string;
}

/**
 * 工作上下文构造证明分别绑定完整请求路线与历史路线、检查点、delta、增强内容和一次性 nonce；
 * 完整 Provider 消息序列由 Pi 集成的 PayloadProofAdapter 另行绑定。
 */
export interface AssemblyProof {
  nonce: string;
  generation: string;
  requestRouteFingerprint: string;
  historicalRouteFingerprint: string;
  checkpointIdentity: string;
  retentionBudgetIdentity: string;
  deltaHash: string;
  openVikingSessionId: string | null;
  enhancedContentHash: string;
  providerPayloadProfileId: string;
}

export function assemblyRouteProofError(
  proof: AssemblyProof,
  requestRouteFingerprint: string | undefined,
  historicalRouteFingerprint: string | undefined,
): string | undefined {
  if (requestRouteFingerprint !== proof.requestRouteFingerprint) {
    return "complete request route changed after the context decision";
  }
  if (historicalRouteFingerprint !== proof.historicalRouteFingerprint) {
    return "historical route changed after the context decision";
  }
  return undefined;
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
  | { kind: "refresh-required"; fault: ContextFault }
  | { kind: "block"; fault: ContextFault };

export interface AuthorizationInput<T> {
  generation: string;
  requestRoute: SessionRouteIdentity;
  historical: ResolvedHistoricalContext;
  messages: readonly T[];
  providerPayloadProfile: ProviderPayloadProfile;
  toolSources: CurrentTurnToolSources;
  toProviderMessages(messages: readonly T[]): readonly unknown[];
  ensureSources(entryIds: readonly string[]): Promise<void>;
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

export function createRetentionBudgetIdentity(
  profile: ProviderPayloadProfile,
  policy: RetentionPolicy,
): string {
  return sha256({
    schemaVersion: 1,
    policy,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
    fixedTokenUpperBound: profile.fixedTokenUpperBound,
    messageTokenBudget: profile.messageTokenBudget,
    estimator: profile.estimator,
  });
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

function projectionMessageText(message: MemoryCheckpoint["activeHistory"][number]): string {
  const sourceIds = message.sourceMessageIds.join(",");
  return `[${message.role}${sourceIds ? `; Pi entries ${sourceIds}` : ""}]\n${message.text}`;
}

function deltaText(delta: VerifiedActiveDelta): string {
  return projectMemorySources(delta.projections)
    .map((message) => `[${message.role}; Pi entries ${message.source_message_ids.join(",")}]\n${message.content}`)
    .join("\n\n");
}

function boundedMiddle(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const marker = "\n… content omitted …\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-(available - head))}`;
}

export function formatWorkingContext(
  historical: ResolvedHistoricalContext,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string | undefined {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new Error("Context character limit must be at least 256");
  const { route, checkpoint, delta } = historical;
  const overview = checkpoint.workingMemory.trim();
  const active = checkpoint.activeHistory.map(projectionMessageText).filter(Boolean).join("\n\n");
  const deltaContent = deltaText(delta);
  let result = [
    "# Enhanced session context",
    `Pi history leaf: ${route.leafId ?? "root"}`,
    "This is a bounded derivative of the current Pi route. Use recall_session to verify critical source details.",
  ].join("\n");
  const deltaSection = deltaContent ? `\n\n## Verified active delta\n${deltaContent}` : "";
  const checkpointLimit = maxChars - deltaSection.length;
  if (checkpointLimit < result.length) return undefined;

  const overviewPrefix = "\n\n## Working memory\n";
  const activePrefix = "\n\n## Checkpoint active history\n";
  const appendSection = (prefix: string, content: string, fromTail: boolean, cap = Number.POSITIVE_INFINITY) => {
    const allowance = Math.min(cap, checkpointLimit - result.length - prefix.length);
    if (!content || allowance <= 0) return;
    const selected = fromTail
      ? content.length <= allowance ? content : content.slice(-allowance)
      : boundedMiddle(content, allowance);
    result += `${prefix}${selected}`;
  };
  const overviewCap = active
    ? Math.max(0, Math.floor((checkpointLimit - result.length - overviewPrefix.length - activePrefix.length) / 2))
    : Number.POSITIVE_INFINITY;
  appendSection(overviewPrefix, overview, false, Math.min(24_000, overviewCap));
  appendSection(activePrefix, active, true);
  result += deltaSection;
  if (result.length > maxChars) return undefined;
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
      checkpointIdentity: prepared.checkpointIdentity,
      retentionBudgetIdentity: prepared.retentionBudgetIdentity,
      deltaHash: prepared.deltaHash,
      openVikingSessionId: prepared.openVikingSessionId,
      hasWorkingMemory: prepared.hasWorkingMemory,
      nonce,
    },
    timestamp: Date.now(),
  } as T;
  return [enhancedMessage, ...messages.slice(currentPromptIndex)];
}

export class WorkingContextOptimizer {
  private readonly maxContextChars: number;

  constructor(options: WorkingContextOptions = {}) {
    this.maxContextChars = positiveInteger(options.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, "Context character limit");
    if (this.maxContextChars < 256) throw new Error("Context character limit must be at least 256");
  }

  prepare(historical: ResolvedHistoricalContext): PreparedWorkingContext {
    const prepared = this.project(historical);
    if (!prepared) throw new Error("Historical context exceeds the working context character limit");
    return prepared;
  }
  /**
   * 工作上下文模块只消费已核验 checkpoint 与 delta；需要折叠历史时返回 refresh-required，
   * 不创建 OpenViking Session，也不执行 append、commit 或 task polling。
   */
  async authorize<T>(input: AuthorizationInput<T>): Promise<ContextAuthorization<T>> {
    try {
      if (input.historical.hasOpaqueSegment) {
        return {
          kind: "block",
          fault: {
            kind: "opaque-content-unrepresentable",
            detail: "The historical route contains Provider-visible content without a lossless memory projection",
          },
        };
      }
      input.signal?.throwIfAborted();
      const { route, checkpoint, delta } = input.historical;
      if (checkpoint.generation !== input.generation) {
        return { kind: "block", fault: { kind: "route", detail: "MemoryCheckpoint belongs to another runtime generation" } };
      }
      if (delta.checkpointIdentity !== checkpoint.identity) {
        return { kind: "block", fault: { kind: "route", detail: "VerifiedActiveDelta does not follow the selected MemoryCheckpoint" } };
      }
      const parsed = currentTurnUnits(input.messages, input.toolSources);
      if (parsed.fault || !parsed.units) {
        return { kind: "block", fault: parsed.fault ?? { kind: "route", detail: "Current turn is unavailable" } };
      }
      const toolBatchIndexes = parsed.units
        .map((unit, index) => ({ unit, index }))
        .filter((item) => item.unit.kind === "tool-batch");
      const selected = parsed.units.map((unit) => unit.raw);
      const nonce = randomUUID();
      let fitted = this.fitEnhancedContext(
        input.historical,
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
            input.historical,
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
        if (opaque) {
          return {
            kind: "block",
            fault: {
              kind: "opaque-content-unrepresentable",
              detail: "Current Provider-visible content cannot be represented within the Provider payload budget",
            },
          };
        }
        if (delta.projections.length > 0) {
          return {
            kind: "refresh-required",
            fault: {
              kind: "checkpoint-refresh-required",
              detail: "VerifiedActiveDelta must be folded into a checkpoint for the current Provider payload budget",
            },
          };
        }
        return {
          kind: "block",
          fault: {
            kind: "budget",
            detail: "Current turn and the minimum checkpoint history exceed the Provider payload budget",
          },
        };
      }
      const projectedSourceEntryIds = [...new Set([...projectedIndexes]
        .flatMap((index) => parsed.units![index].sourceEntryIds))];
      input.signal?.throwIfAborted();
      if (projectedSourceEntryIds.length > 0) await input.ensureSources(projectedSourceEntryIds);
      input.signal?.throwIfAborted();
      return {
        kind: "allow",
        enhancedContext: fitted.enhancedContext,
        proof: {
          nonce,
          generation: input.generation,
          requestRouteFingerprint: input.requestRoute.fingerprint,
          historicalRouteFingerprint: route.fingerprint,
          checkpointIdentity: checkpoint.identity,
          retentionBudgetIdentity: checkpoint.retentionBudgetIdentity,
          deltaHash: delta.hash,
          openVikingSessionId: fitted.prepared.openVikingSessionId,
          enhancedContentHash: sha256(enhancedContent(fitted.prepared, nonce)),
          providerPayloadProfileId: input.providerPayloadProfile.identity,
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

  private fitEnhancedContext<T>(
    historical: ResolvedHistoricalContext,
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
      const projected = this.project(historical, maxChars);
      if (!projected) {
        low = maxChars + 1;
        continue;
      }
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
    historical: ResolvedHistoricalContext,
    maxChars = this.maxContextChars,
  ): PreparedWorkingContext | undefined {
    const content = formatWorkingContext(historical, maxChars);
    if (!content) return undefined;
    return {
      route: historical.route,
      checkpointIdentity: historical.checkpoint.identity,
      retentionBudgetIdentity: historical.checkpoint.retentionBudgetIdentity,
      deltaHash: historical.delta.hash,
      openVikingSessionId: historical.checkpoint.openVikingSessionId,
      content,
      estimatedTokens: Math.ceil(content.length / 4),
      hasWorkingMemory: historical.checkpoint.workingMemory.length > 0,
    };
  }
}
