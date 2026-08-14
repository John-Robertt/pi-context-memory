import type { SourceEntry } from "./long-term-memory.ts";

export type PiProjectionKind = "user_query" | "assistant_step" | "tool_transport" | "checkpoint";

export interface NormalizedPiEntry {
  source: SourceEntry;
  text: string;
  projectionRole: "user" | "assistant";
  projectionKind: PiProjectionKind;
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

const PI_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);
const PI_NON_CONTEXT_ENTRY_TYPES = new Set([
  "thinking_level_change",
  "model_change",
  "custom",
  "label",
  "session_info",
]);

export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) throw new Error("Unsupported Pi message content shape");
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || typeof (block as Record<string, unknown>).type !== "string") {
      throw new Error("Unsupported Pi message content block");
    }
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
    else if (value.type === "toolCall" && typeof value.name === "string") {
      parts.push(`Tool call ${value.name}: ${JSON.stringify(value.arguments ?? {})}`);
    } else if (value.type === "image" && typeof value.mimeType === "string") parts.push(`[image ${value.mimeType}]`);
    else if (value.type === "thinking" && typeof value.thinking === "string") continue;
    else throw new Error(`Unsupported Pi message content block: ${String(value.type)}`);
  }
  return parts.join("\n");
}

function normalizedMessageText(message: Record<string, unknown>): string {
  const role = message.role;
  if (typeof role !== "string" || !PI_MESSAGE_ROLES.has(role)) {
    throw new Error(`Unsupported Pi message role: ${String(role)}`);
  }
  if (role === "bashExecution") {
    if (typeof message.command !== "string" || typeof message.output !== "string") {
      throw new Error("Unsupported Pi bash execution message");
    }
    return [`Command: ${message.command}`, `Output:\n${message.output}`].join("\n");
  }
  return [
    `Message role: ${role}`,
    typeof message.toolName === "string" ? `Tool: ${message.toolName}` : "",
    typeof message.isError === "boolean" ? `Tool error: ${message.isError}` : "",
    piContentText(message.content),
  ].filter(Boolean).join("\n");
}

function messageEntryText(entry: SourceEntry): string {
  if (!entry.message || typeof entry.message !== "object") throw new Error("Pi message entry has no message");
  return normalizedMessageText(entry.message as Record<string, unknown>);
}

function compactionText(entry: SourceEntry): string {
  if (typeof entry.summary !== "string") throw new Error("Pi compaction entry has no summary");
  if (entry.retainedTail === undefined && typeof entry.firstKeptEntryId !== "string") {
    throw new Error("Pi compaction entry has no retained boundary");
  }
  if (entry.retainedTail !== undefined && !Array.isArray(entry.retainedTail)) {
    throw new Error("Pi compaction retained tail is invalid");
  }
  const retainedTail = Array.isArray(entry.retainedTail)
    ? entry.retainedTail.map((message) => {
      if (!message || typeof message !== "object") throw new Error("Pi compaction retained message is invalid");
      return `[retained]\n${normalizedMessageText(message as Record<string, unknown>)}`;
    }).join("\n\n")
    : "";
  return [entry.summary, retainedTail].filter(Boolean).join("\n\n");
}

export function normalizePiEntry(entry: SourceEntry): NormalizedPiEntry {
  let text = "";
  let projectionRole: "user" | "assistant" = "user";
  let projectionKind: PiProjectionKind = "checkpoint";

  if (entry.type === "message") {
    text = messageEntryText(entry);
    const message = entry.message && typeof entry.message === "object"
      ? entry.message as Record<string, unknown>
      : undefined;
    const role = message?.role;
    if (role === "user") projectionKind = "user_query";
    else if (role === "assistant") {
      projectionRole = "assistant";
      projectionKind = "assistant_step";
    } else if (role === "toolResult" || role === "bashExecution") projectionKind = "tool_transport";
  } else if (entry.type === "compaction") {
    text = compactionText(entry);
  } else if (entry.type === "branch_summary") {
    if (typeof entry.summary !== "string") throw new Error("Pi branch summary entry has no summary");
    text = entry.summary;
  } else if (entry.type === "custom_message") {
    text = piContentText(entry.content);
  } else if (!PI_NON_CONTEXT_ENTRY_TYPES.has(entry.type)) {
    throw new Error(`Unsupported Pi session entry type: ${entry.type}`);
  }

  return { source: entry, text: text.trim(), projectionRole, projectionKind };
}

export function effectivePiProjectionEntries(entries: readonly SourceEntry[]): NormalizedPiEntry[] {
  const compactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  if (compactionIndex < 0) return entries.map(normalizePiEntry);
  const compaction = entries[compactionIndex];
  const afterCompaction = entries.slice(compactionIndex + 1);
  if (Array.isArray(compaction.retainedTail)) {
    return [compaction, ...afterCompaction].map(normalizePiEntry);
  }
  const firstKeptEntryId = compaction.firstKeptEntryId;
  const firstKeptIndex = typeof firstKeptEntryId === "string"
    ? entries.findIndex((entry, index) => index < compactionIndex && entry.id === firstKeptEntryId)
    : -1;
  const retainedEntries = firstKeptIndex >= 0 ? entries.slice(firstKeptIndex, compactionIndex) : [];
  return [compaction, ...retainedEntries, ...afterCompaction].map(normalizePiEntry);
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

export function largeResultOf(entry: SourceEntry): { toolCallId: string; fullOutputPath: string } | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
  const message = entry.message as Record<string, unknown>;
  if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return undefined;
  if (!message.details || typeof message.details !== "object") return undefined;
  const fullOutputPath = (message.details as Record<string, unknown>).fullOutputPath;
  return typeof fullOutputPath === "string" && fullOutputPath.length > 0
    ? { toolCallId: message.toolCallId, fullOutputPath }
    : undefined;
}
