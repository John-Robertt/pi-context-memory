import { createHash } from "node:crypto";

/** Pi session entry 的结构最小面；正文语义不由本模块解释。 */
export interface SourceEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * 宿主协议 profile：由 Pi 集成注入当前 Pi 版本的权威转换。
 * 本模块保持纯函数，不直接依赖宿主包，因此受控 runner 可以在没有完整 Pi 进程时验证投影。
 */
export interface PiProtocolProfile {
  id: string;
  contextEntries(entries: readonly SourceEntry[], leafId: string | null): readonly SourceEntry[];
  providerMessages(entry: SourceEntry): readonly ProviderMessage[];
}

export type ProviderMessage = Record<string, unknown> & { role: string };

export type ProviderRole = "user" | "assistant" | "toolResult";

export interface TaskCompletion {
  stopReason?: string;
  isError?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface MessageSource {
  kind: "message-source";
  id: string;
  parentId: string | null;
  role: ProviderRole;
  timestamp: string;
  taskContent: readonly unknown[];
  completion: TaskCompletion | undefined;
  taskContentHash: string;
  authorityHash: string;
}

export interface ControlBoundary {
  kind: "control-boundary";
  type: "compaction" | "branch-summary";
  id: string;
  parentId: string | null;
  firstKeptEntryId?: string;
  fromId?: string;
}

export interface OpaqueProviderSegment {
  kind: "opaque-provider-segment";
  reason: "unsupported-content" | "tool-protocol";
  entryIds: readonly string[];
  providerMessages: readonly ProviderMessage[];
  providerViewHash: string;
}

export type MemoryProjection = MessageSource | ControlBoundary | OpaqueProviderSegment;

/** 瞬时定位候选：只在流式复制期间存在，不持久化、不进入投影、日志或 payload。 */
export interface FullOutputCandidate {
  entryId: string;
  path: string;
}

export interface PiProtocolProjection {
  profileId: string;
  providerBaseline: readonly ProviderMessage[];
  projections: readonly MemoryProjection[];
  fullOutputCandidates: readonly FullOutputCandidate[];
}

const PROVIDER_ROLES = new Set<ProviderRole>(["user", "assistant", "toolResult"]);

/** 可投影为任务内容的公开 block；thinking 是结构化私有内容，省略但不使整单元 opaque。 */
const TASK_BLOCK_TYPES = new Set(["text", "toolCall"]);
const PRIVATE_BLOCK_TYPES = new Set(["thinking"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function isSourceEntry(value: unknown): value is SourceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.type === "string"
    && typeof entry.id === "string"
    && entry.id.length > 0
    && (entry.parentId === null || typeof entry.parentId === "string")
    && typeof entry.timestamp === "string";
}

function blocksOf(message: ProviderMessage): readonly Record<string, unknown>[] | undefined {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return undefined;
  if (!content.every((block) =>
    Boolean(block) && typeof block === "object" && typeof (block as Record<string, unknown>).type === "string")) {
    return undefined;
  }
  return content as Record<string, unknown>[];
}

/** 单元能否形成记忆投影，只依据 Provider 基线的 block 结构，不读取正文，也不看 customType。 */
function projectable(messages: readonly ProviderMessage[]): boolean {
  return messages.every((message) => {
    if (!PROVIDER_ROLES.has(message.role as ProviderRole)) return false;
    const blocks = blocksOf(message);
    if (!blocks) return false;
    return blocks.every((block) => {
      const type = block.type as string;
      return TASK_BLOCK_TYPES.has(type) || PRIVATE_BLOCK_TYPES.has(type);
    });
  });
}

function completionOf(message: ProviderMessage): TaskCompletion | undefined {
  const completion: TaskCompletion = {};
  if (typeof message.stopReason === "string") completion.stopReason = message.stopReason;
  if (typeof message.isError === "boolean") completion.isError = message.isError;
  if (typeof message.cancelled === "boolean") completion.cancelled = message.cancelled;
  if (typeof message.truncated === "boolean") completion.truncated = message.truncated;
  return Object.keys(completion).length > 0 ? completion : undefined;
}

/** 已知 locator 的精确脱敏：只替换权威结构字段提供的字面路径，不解析正文语义。 */
export function sanitizeFullOutputLocators<T>(
  value: T,
  candidates: readonly FullOutputCandidate[],
): T {
  if (candidates.length === 0) return value;
  const replacements = candidates.map((candidate) => ({
    path: candidate.path,
    marker: `[full output available via recall_session read_source ${candidate.entryId}]`,
  }));
  const seen = new WeakMap<object, unknown>();
  const sanitize = (current: unknown): unknown => {
    if (typeof current === "string") {
      return replacements.reduce(
        (text, replacement) => text.split(replacement.path).join(replacement.marker),
        current,
      );
    }
    if (!current || typeof current !== "object") return current;
    const known = seen.get(current);
    if (known !== undefined) return known;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      result.push(...current.map(sanitize));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) result[key] = sanitize(child);
    return result;
  };
  return sanitize(value) as T;
}


function fullOutputPathOf(entry: SourceEntry): string | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
  const message = entry.message as Record<string, unknown>;
  if (message.role === "bashExecution") {
    return typeof message.fullOutputPath === "string" && message.fullOutputPath.length > 0
      ? message.fullOutputPath
      : undefined;
  }
  if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") return undefined;
  const path = (message.details as Record<string, unknown>).fullOutputPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function toolCallState(messages: readonly ProviderMessage[]): { ids: string[]; malformed: boolean } {
  const calls = messages.flatMap((message) => (blocksOf(message) ?? [])
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ message, block })));
  const ids: string[] = [];
  let malformed = false;
  for (const call of calls) {
    const id = call.block.id;
    if (call.message.role !== "assistant" || typeof id !== "string" || id.length === 0) malformed = true;
    else ids.push(id);
  }
  return { ids, malformed };
}

function controlBoundaryOf(entry: SourceEntry): ControlBoundary | undefined {
  if (entry.type === "compaction") {
    const boundary: ControlBoundary = {
      kind: "control-boundary",
      type: "compaction",
      id: entry.id,
      parentId: entry.parentId,
    };
    if (typeof entry.firstKeptEntryId === "string") boundary.firstKeptEntryId = entry.firstKeptEntryId;
    return boundary;
  }
  if (entry.type === "branch_summary") {
    const boundary: ControlBoundary = {
      kind: "control-boundary",
      type: "branch-summary",
      id: entry.id,
      parentId: entry.parentId,
    };
    if (typeof entry.fromId === "string") boundary.fromId = entry.fromId;
    return boundary;
  }
  return undefined;
}

interface ProtocolUnit {
  entries: readonly SourceEntry[];
  messages: readonly ProviderMessage[];
  complete: boolean;
}

/**
 * 按完整工具协议单元分组：带 toolCall 的 assistant 与其 toolResult 属于同一单元，
 * 不拆散 call/result 关系。其余 entry 各自成一个单元。
 */
function protocolUnits(
  entries: readonly SourceEntry[],
  messagesByEntry: ReadonlyMap<string, readonly ProviderMessage[]>,
): ProtocolUnit[] {
  const units: ProtocolUnit[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    const messages = messagesByEntry.get(entry.id) ?? [];
    const calls = toolCallState(messages);
    const callIds = calls.ids;
    if (callIds.length === 0) {
      const orphanResult = messages.some((message) => message.role === "toolResult");
      units.push({ entries: [entry], messages, complete: !orphanResult && !calls.malformed });
      index += 1;
      continue;
    }

    const pendingCallIds = new Set(callIds);
    let malformed = calls.malformed || pendingCallIds.size !== callIds.length;
    const unitEntries: SourceEntry[] = [entry];
    const unitMessages: ProviderMessage[] = [...messages];
    let cursor = index + 1;
    while (cursor < entries.length && pendingCallIds.size > 0) {
      const candidate = entries[cursor];
      const candidateMessages = messagesByEntry.get(candidate.id) ?? [];
      if (candidateMessages.length === 0 || candidateMessages.some((message) => message.role !== "toolResult")) break;

      const resultIds = candidateMessages.map((message) =>
        typeof message.toolCallId === "string" ? message.toolCallId : undefined);
      const uniqueResultIds = new Set(resultIds.filter((id): id is string => Boolean(id)));
      if (uniqueResultIds.size !== resultIds.length) malformed = true;
      for (const resultId of uniqueResultIds) {
        if (!pendingCallIds.delete(resultId)) malformed = true;
      }
      unitEntries.push(candidate);
      unitMessages.push(...candidateMessages);
      cursor += 1;
    }
    units.push({
      entries: unitEntries,
      messages: unitMessages,
      complete: !malformed && pendingCallIds.size === 0,
    });
    index = cursor;
  }
  return units;
}

function messageSourcesOf(unit: ProtocolUnit): MessageSource[] {
  const sources: MessageSource[] = [];
  for (const entry of unit.entries) {
    const authorityHash = stableHash(entry);
    for (const message of unit.messages.filter((candidate) => candidate.__entryId === entry.id)) {
      const blocks = blocksOf(message) ?? [];
      const taskContent = blocks.filter((block) => TASK_BLOCK_TYPES.has(block.type as string));
      const completion = completionOf(message);
      sources.push({
        kind: "message-source",
        id: entry.id,
        parentId: entry.parentId,
        role: message.role as ProviderRole,
        timestamp: entry.timestamp,
        taskContent,
        completion,
        taskContentHash: stableHash({ taskContent, completion }),
        authorityHash,
      });
    }
  }
  return sources;
}

/**
 * 从当前路线产生两个正交结果：交给任务模型的 Provider 基线，以及可归档的记忆投影。
 * 只依据 Pi 结构判别字段、明示元数据和协议关系，不读取正文语义。
 */
export function projectRoute(
  profile: PiProtocolProfile,
  entries: readonly SourceEntry[],
  leafId: string | null,
): PiProtocolProjection {
  const contextEntries = profile.contextEntries(entries, leafId);
  const providerBaseline: ProviderMessage[] = [];
  const messagesByEntry = new Map<string, readonly ProviderMessage[]>();
  const fullOutputCandidates: FullOutputCandidate[] = [];
  for (const entry of contextEntries) {
    if (!isSourceEntry(entry)) throw new Error(`Invalid Pi session entry in the current route`);
    const rawMessages = profile.providerMessages(entry);
    const path = fullOutputPathOf(entry);
    const providerMessages = path
      ? sanitizeFullOutputLocators(rawMessages, [{ entryId: entry.id, path }])
      : rawMessages;
    if (path && providerMessages.length > 0) fullOutputCandidates.push({ entryId: entry.id, path });
    // 标注来源 entry 供单元内配对；该字段只在请求内存中存在，不进入基线输出或投影内容。
    const messages = providerMessages.map((message) => ({ ...message, __entryId: entry.id }));
    messagesByEntry.set(entry.id, messages);
    providerBaseline.push(...providerMessages);
  }

  const projections: MemoryProjection[] = [];
  for (const unit of protocolUnits(contextEntries, messagesByEntry)) {
    const boundary = unit.entries.length === 1 ? controlBoundaryOf(unit.entries[0]) : undefined;
    if (boundary) {
      projections.push(boundary);
      continue;
    }
    if (unit.messages.length === 0) continue;
    if (!unit.complete || !projectable(unit.messages)) {
      const providerMessages = unit.messages.map(({ __entryId, ...message }) => message as ProviderMessage);
      projections.push({
        kind: "opaque-provider-segment",
        reason: unit.complete ? "unsupported-content" : "tool-protocol",
        entryIds: unit.entries.map((entry) => entry.id),
        providerMessages,
        providerViewHash: stableHash(providerMessages),
      });
      continue;
    }
    projections.push(...messageSourcesOf(unit));
  }

  return { profileId: profile.id, providerBaseline, projections, fullOutputCandidates };
}

export function isMessageSource(projection: MemoryProjection): projection is MessageSource {
  return projection.kind === "message-source";
}

export function isControlBoundary(projection: MemoryProjection): projection is ControlBoundary {
  return projection.kind === "control-boundary";
}

export function isOpaqueProviderSegment(projection: MemoryProjection): projection is OpaqueProviderSegment {
  return projection.kind === "opaque-provider-segment";
}

/** 重新核对归档来源与当前 Pi 权威 entry：taskContent、完成状态与两个哈希必须精确一致。 */
export function sameMessageSource(left: MessageSource, right: MessageSource): boolean {
  return left.id === right.id
    && left.parentId === right.parentId
    && left.role === right.role
    && left.timestamp === right.timestamp
    && left.taskContentHash === right.taskContentHash
    && left.authorityHash === right.authorityHash
    && JSON.stringify(left.taskContent) === JSON.stringify(right.taskContent)
    && JSON.stringify(left.completion ?? null) === JSON.stringify(right.completion ?? null);
}

export function entriesBeforeCurrentPrompt(entries: readonly SourceEntry[]): readonly SourceEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    if ((entry.message as Record<string, unknown>).role === "user") return entries.slice(0, index);
  }
  return entries;
}

export function currentUserMessageIndex(messages: readonly unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as Record<string, unknown>).role === "user") return index;
  }
  return -1;
}
