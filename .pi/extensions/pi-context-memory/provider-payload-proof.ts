import { createHash } from "node:crypto";

export const OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER = "openai-completions-payload-v1";

export interface ProviderPayloadProof {
  adapterId: typeof OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER;
  provider: string;
  model: string;
  api: "openai-completions";
  messagesHash: string;
  messageCount: number;
}

export interface OpenAICompletionsPayloadProfileProof {
  systemPromptHash: string;
  toolsHash: string;
  maxOutputTokens: number;
}

interface CanonicalMessage {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  toolCalls?: readonly unknown[];
  toolCallId?: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

/** 支持 adapter 的完整 tool wrapper 字节上界；strict=false 比不发送 strict 更大。 */
export function openAICompletionsToolPayloadUpperBoundBytes(tools: unknown): number {
  if (!Array.isArray(tools)) throw new Error("OpenAI completions tools must be an array");
  const payloadTools = tools.map((tool) => {
    if (!tool || typeof tool !== "object") throw new Error("OpenAI completions tool is malformed");
    const value = tool as Record<string, unknown>;
    if (typeof value.name !== "string"
      || typeof value.description !== "string"
      || !value.parameters
      || typeof value.parameters !== "object") throw new Error("OpenAI completions tool is malformed");
    return {
      type: "function",
      function: {
        name: value.name,
        description: value.description,
        parameters: value.parameters,
        strict: false,
      },
    };
  });
  return Buffer.byteLength(JSON.stringify(stable(payloadTools)), "utf8");
}

function textContent(text: string): unknown[] {
  return [{ type: "text", text }];
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isInstructionMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value
    && typeof value === "object"
    && ((value as Record<string, unknown>).role === "system"
      || (value as Record<string, unknown>).role === "developer"));
}

function canonicalPiContent(content: unknown): unknown[] | undefined {
  if (typeof content === "string") return textContent(content);
  if (!Array.isArray(content)) return undefined;
  const normalized: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") return undefined;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      normalized.push({ type: "text", text: value.text });
    } else if (value.type === "image" && typeof value.mimeType === "string" && typeof value.data === "string") {
      normalized.push({ type: "image", mimeType: value.mimeType, data: value.data });
    } else if (value.type !== "toolCall") {
      return undefined;
    }
  }
  return normalized;
}

function canonicalPiMessage(message: unknown): CanonicalMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as Record<string, unknown>;
  if (value.role === "user") {
    const content = canonicalPiContent(value.content);
    return content ? { role: "user", content } : undefined;
  }
  if (value.role === "assistant" && Array.isArray(value.content)) {
    const content = canonicalPiContent(value.content);
    if (!content) return undefined;
    const toolCalls = value.content
      .filter((block) => Boolean(block) && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall")
      .map((block) => {
        const call = block as Record<string, unknown>;
        if (typeof call.id !== "string" || typeof call.name !== "string") return undefined;
        return { id: call.id, name: call.name, arguments: stable(call.arguments ?? {}) };
      });
    if (toolCalls.some((call) => call === undefined)) return undefined;
    return { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }
  if (value.role === "toolResult" && typeof value.toolCallId === "string") {
    const content = canonicalPiContent(value.content);
    return content ? { role: "toolResult", content, toolCallId: value.toolCallId } : undefined;
  }
  return undefined;
}

function canonicalOpenAIContent(content: unknown): unknown[] | undefined {
  if (content === null) return [];
  if (typeof content === "string") return textContent(content);
  if (!Array.isArray(content)) return undefined;
  const normalized: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") return undefined;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string" && hasOnlyKeys(value, ["type", "text"])) {
      normalized.push({ type: "text", text: value.text });
      continue;
    }
    const imageUrl = value.image_url;
    const url = imageUrl && typeof imageUrl === "object"
      && hasOnlyKeys(value, ["type", "image_url"])
      && hasOnlyKeys(imageUrl as Record<string, unknown>, ["url"])
      ? (imageUrl as Record<string, unknown>).url
      : undefined;
    const match = typeof url === "string" ? /^data:([^;]+);base64,(.*)$/s.exec(url) : undefined;
    if (!match) return undefined;
    normalized.push({ type: "image", mimeType: match[1], data: match[2] });
  }
  return normalized;
}

function canonicalOpenAIMessage(message: unknown): CanonicalMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as Record<string, unknown>;
  if (value.role === "user" && hasOnlyKeys(value, ["role", "content"])) {
    const content = canonicalOpenAIContent(value.content);
    return content ? { role: "user", content } : undefined;
  }
  if (value.role === "assistant" && hasOnlyKeys(value, ["role", "content", "tool_calls"])) {
    const content = canonicalOpenAIContent(value.content);
    if (!content) return undefined;
    const rawCalls = value.tool_calls;
    const toolCalls = rawCalls === undefined ? [] : Array.isArray(rawCalls) ? rawCalls.map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const call = item as Record<string, unknown>;
      if (!hasOnlyKeys(call, ["id", "type", "function"]) || call.type !== "function") return undefined;
      const fn = call.function;
      if (typeof call.id !== "string" || !fn || typeof fn !== "object"
        || !hasOnlyKeys(fn as Record<string, unknown>, ["name", "arguments"])) return undefined;
      const name = (fn as Record<string, unknown>).name;
      const args = (fn as Record<string, unknown>).arguments;
      if (typeof name !== "string" || typeof args !== "string") return undefined;
      try {
        return { id: call.id, name, arguments: stable(JSON.parse(args)) };
      } catch {
        return undefined;
      }
    }) : [undefined];
    if (toolCalls.some((call) => call === undefined)) return undefined;
    return { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
  }
  if (value.role === "tool" && typeof value.tool_call_id === "string"
    && hasOnlyKeys(value, ["role", "content", "tool_call_id"])) {
    const content = canonicalOpenAIContent(value.content);
    return content ? { role: "toolResult", content, toolCallId: value.tool_call_id } : undefined;
  }
  return undefined;
}

export function createOpenAICompletionsPayloadProof(
  provider: string,
  model: string,
  messages: readonly unknown[],
): ProviderPayloadProof | undefined {
  const canonical = messages.map(canonicalPiMessage);
  if (canonical.some((message) => message === undefined)) return undefined;
  return {
    adapterId: OPENAI_COMPLETIONS_PAYLOAD_PROOF_ADAPTER,
    provider,
    model,
    api: "openai-completions",
    messagesHash: hash(canonical),
    messageCount: canonical.length,
  };
}

export function openAICompletionsPayloadMatches(
  payload: unknown,
  nonce: string,
  proof: ProviderPayloadProof,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  if (value.model !== proof.model) return false;
  const messages = value.messages;
  if (!Array.isArray(messages)) return false;
  const start = messages.findIndex((message) => JSON.stringify(message).includes(nonce));
  if (start < 0) return false;
  const prefix = messages.slice(0, start);
  if (prefix.length !== 1 || !isInstructionMessage(prefix[0])) return false;
  const constructed = messages.slice(start);
  if (constructed.length !== proof.messageCount) return false;
  const canonical = constructed.map(canonicalOpenAIMessage);
  return !canonical.some((message) => message === undefined) && hash(canonical) === proof.messagesHash;
}

/** 核对本 handler 实际可见的 OpenAI payload 中所有 ProviderPayloadProfile 预算事实。 */
export function openAICompletionsPayloadMatchesProfile(
  payload: unknown,
  proof: OpenAICompletionsPayloadProfileProof,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  const messages = value.messages;
  if (!Array.isArray(messages)) return false;
  const instructionMessages = messages.filter(isInstructionMessage);
  if (instructionMessages.length !== 1 || messages[0] !== instructionMessages[0]) return false;
  const instructionMessage = instructionMessages[0];
  if (!hasOnlyKeys(instructionMessage, ["role", "content"]) || typeof instructionMessage.content !== "string") return false;

  const rawTools = value.tools === undefined ? [] : value.tools;
  if (!Array.isArray(rawTools)) return false;
  const tools = rawTools.map((tool) => {
    if (!tool || typeof tool !== "object") return undefined;
    const outer = tool as Record<string, unknown>;
    if (!hasOnlyKeys(outer, ["type", "function"]) || outer.type !== "function") return undefined;
    const fn = outer.function;
    if (!fn || typeof fn !== "object") return undefined;
    const definition = fn as Record<string, unknown>;
    if (!hasOnlyKeys(definition, ["name", "description", "parameters", "strict"])
      || typeof definition.name !== "string"
      || typeof definition.description !== "string"
      || !definition.parameters
      || typeof definition.parameters !== "object"
      || (definition.strict !== undefined && definition.strict !== false)) return undefined;
    return { name: definition.name, description: definition.description, parameters: definition.parameters };
  });
  if (tools.some((tool) => tool === undefined)) return false;

  const maxOutput = value.max_completion_tokens ?? value.max_tokens;
  if (value.max_completion_tokens !== undefined && value.max_tokens !== undefined) return false;
  return maxOutput === proof.maxOutputTokens
    && hash(instructionMessage.content) === proof.systemPromptHash
    && hash(tools) === proof.toolsHash;
}
