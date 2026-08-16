import { createHash, randomUUID } from "node:crypto";

import {
  OpenVikingHttpClient,
  normalizeCommitResult,
  normalizeSessionContext,
  normalizeTaskState,
} from "./openviking-protocol.ts";
import type { OpenVikingRuntimeState } from "./memory-model-configuration.ts";
import {
  assertMemoryRuntimeProfile,
  memoryRuntimeProfileFingerprint,
  type MemoryRuntimeProfile,
} from "./memory-runtime-profile.ts";

export const MEMORY_CAPABILITY_PROOF_VERSION = 2 as const;
export const MEMORY_CAPABILITY_PROBE_VERSION = "openviking-session-capability-v1" as const;
const PROBE_SOURCE_IDS = ["pcm-capability-v1-user", "pcm-capability-v1-assistant"] as const;
const PROBE_MARKER = "PCM-CAPABILITY-V1";
const PROBE_CONTEXT_TOKEN_BUDGET = 2_048;
const PROBE_POLL_INTERVAL_MS = 250;
export interface MemoryCapabilityUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MemoryCapabilityProof {
  proofVersion: typeof MEMORY_CAPABILITY_PROOF_VERSION;
  proofId: string;
  probeVersion: typeof MEMORY_CAPABILITY_PROBE_VERSION;
  launchId: string;
  childPid: number;
  provider: string;
  model: string;
  api: MemoryRuntimeProfile["api"];
  settingsFingerprint: string;
  configFingerprint: string;
  profileFingerprint: string;
  adapterVersion: MemoryRuntimeProfile["adapterVersion"];
  taskId: string;
  assemblyHash: string;
  usage: MemoryCapabilityUsage;
  completedAt: string;
}

export interface MemoryCapabilityBinding {
  launchId: string;
  childPid: number;
  settingsFingerprint: string;
  configFingerprint: string;
  profile: MemoryRuntimeProfile;
  profileFingerprint: string;
}

export interface MemoryCapabilityProbeInput extends MemoryCapabilityBinding {
  baseUrl: string;
  apiKey?: string;
  now?: () => number;
  signal?: AbortSignal;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function positiveToken(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`OpenViking capability task has invalid ${name}`);
  }
  return value;
}

function normalizeTaskUsage(result: unknown): MemoryCapabilityUsage {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("OpenViking capability task has no result");
  }
  const tokenUsage = (result as Record<string, unknown>).token_usage;
  const llm = tokenUsage && typeof tokenUsage === "object" && !Array.isArray(tokenUsage)
    ? (tokenUsage as Record<string, unknown>).llm
    : undefined;
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) {
    throw new Error("OpenViking capability task has no LLM usage");
  }
  const usage = llm as Record<string, unknown>;
  const promptTokens = positiveToken(usage.prompt_tokens, "prompt token usage");
  const completionTokens = positiveToken(usage.completion_tokens, "completion token usage");
  const totalTokens = positiveToken(usage.total_tokens, "total token usage");
  if (totalTokens < promptTokens + completionTokens) {
    throw new Error("OpenViking capability task token usage is inconsistent");
  }
  return { promptTokens, completionTokens, totalTokens };
}

async function waitForCompletedTask(
  client: OpenVikingHttpClient,
  taskId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MemoryCapabilityUsage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const { result } = await client.request<Record<string, unknown>>(
      "GET",
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
    );
    const task = normalizeTaskState(result);
    if (task.status === "completed") return normalizeTaskUsage(result.result);
    if (task.status === "failed" || task.status === "cancelled") {
      throw new Error(`OpenViking capability task ${task.status}: ${String(task.error ?? "unknown error")}`);
    }
    if (task.status !== "pending" && task.status !== "running" && task.status !== "cancelling") {
      throw new Error(`OpenViking capability task returned unknown status ${task.status}`);
    }
    await new Promise<void>((resolveDelay, rejectDelay) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolveDelay();
        else rejectDelay(error);
      };
      const timer = setTimeout(() => finish(), Math.min(PROBE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      const onAbort = () => finish(signal?.reason ?? new Error("OpenViking capability probe cancelled"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error("OpenViking capability task timed out");
}

export async function probeMemoryRuntimeCapability(input: MemoryCapabilityProbeInput): Promise<MemoryCapabilityProof> {
  assertMemoryRuntimeProfile(input.profile);
  const expectedProfileFingerprint = memoryRuntimeProfileFingerprint(input.profile);
  if (input.profileFingerprint !== expectedProfileFingerprint) {
    throw new Error("Memory runtime profile fingerprint is inconsistent");
  }
  if (!input.launchId || !Number.isSafeInteger(input.childPid) || input.childPid <= 0) {
    throw new Error("Memory capability probe requires a managed process identity");
  }
  const client = new OpenVikingHttpClient(
    input.baseUrl,
    input.apiKey,
    Math.min(input.profile.requestTimeoutMs, 30_000),
  );
  const deadlineSignal = AbortSignal.timeout(input.profile.requestTimeoutMs);
  const operationSignal = input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal;
  const sessionId = `pcm-capability-${randomUUID()}`;
  let primaryError: unknown;
  try {
    await client.request("POST", "/api/v1/sessions", {
      session_id: sessionId,
      memory_policy: {
        self: { enabled: false },
        peer: { enabled: false },
        working_memory: { enabled: true },
      },
    }, operationSignal);
    await client.request("POST", `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, {
      messages: [
        {
          role: "user",
          content: "Production memory capability probe. Preserve the source marker PCM-CAPABILITY-V1.",
          created_at: "2026-01-01T00:00:00.000Z",
          source_message_ids: [PROBE_SOURCE_IDS[0]],
        },
        {
          role: "assistant",
          content: "Capability marker PCM-CAPABILITY-V1 acknowledged for source verification.",
          created_at: "2026-01-01T00:00:01.000Z",
          source_message_ids: [PROBE_SOURCE_IDS[1]],
        },
      ],
    }, operationSignal);
    const { result: commitResult } = await client.request(
      "POST",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      { keep_recent_count: 1 },
      operationSignal,
    );
    const commit = normalizeCommitResult(commitResult);
    if (commit.status !== "accepted") throw new Error("OpenViking capability commit was skipped");
    const usage = await waitForCompletedTask(client, commit.taskId, input.profile.requestTimeoutMs, operationSignal);
    const { result: contextResult } = await client.request(
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${PROBE_CONTEXT_TOKEN_BUDGET}`,
      undefined,
      operationSignal,
    );
    const context = normalizeSessionContext(contextResult);
    if (!context.overview || !context.overview.toUpperCase().includes(PROBE_MARKER)) {
      throw new Error("OpenViking capability assembly has no marker-bearing Working Memory overview");
    }
    const allowedSources = new Set<string>(PROBE_SOURCE_IDS);
    if (context.messages.some((message) => message.sourceMessageIds.some((id) => !allowedSources.has(id)))) {
      throw new Error("OpenViking capability assembly contains an unrelated source");
    }
    if (!context.messages.some((message) => message.sourceMessageIds.includes(PROBE_SOURCE_IDS[1]))) {
      throw new Error("OpenViking capability assembly does not preserve the retained probe source");
    }
    const completedAtMs = (input.now ?? Date.now)();
    const completedAt = new Date(completedAtMs).toISOString();
    return {
      proofVersion: MEMORY_CAPABILITY_PROOF_VERSION,
      proofId: randomUUID(),
      probeVersion: MEMORY_CAPABILITY_PROBE_VERSION,
      launchId: input.launchId,
      childPid: input.childPid,
      provider: input.profile.provider,
      model: input.profile.model,
      api: input.profile.api,
      settingsFingerprint: input.settingsFingerprint,
      configFingerprint: input.configFingerprint,
      profileFingerprint: input.profileFingerprint,
      adapterVersion: input.profile.adapterVersion,
      taskId: commit.taskId,
      assemblyHash: sha256(context),
      usage,
      completedAt,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const { result: deletionResult } = await client.request<Record<string, unknown>>(
        "DELETE",
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        undefined,
        AbortSignal.timeout(2_000),
      );
      if (deletionResult.session_id !== sessionId) {
        throw new Error("OpenViking capability probe cleanup was not confirmed");
      }
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (primaryError === undefined) {
        throw new Error(`OpenViking capability probe cleanup failed: ${cleanupMessage}`);
      }
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new AggregateError(
        [primaryError, cleanupError],
        `OpenViking capability probe failed (${primaryMessage}) and cleanup also failed: ${cleanupMessage}`,
      );
    }
  }
}

export function memoryCapabilityMatches(
  proof: MemoryCapabilityProof | undefined,
  binding: MemoryCapabilityBinding,
): proof is MemoryCapabilityProof {
  if (!proof) return false;
  try {
    assertMemoryRuntimeProfile(binding.profile);
  } catch {
    return false;
  }
  if (!Number.isFinite(Date.parse(proof.completedAt))) return false;
  if (!Number.isSafeInteger(proof.usage?.promptTokens) || proof.usage.promptTokens <= 0
    || !Number.isSafeInteger(proof.usage?.completionTokens) || proof.usage.completionTokens <= 0
    || !Number.isSafeInteger(proof.usage?.totalTokens) || proof.usage.totalTokens <= 0
    || proof.usage.totalTokens < proof.usage.promptTokens + proof.usage.completionTokens) return false;
  return proof.proofVersion === MEMORY_CAPABILITY_PROOF_VERSION
    && proof.probeVersion === MEMORY_CAPABILITY_PROBE_VERSION
    && proof.launchId === binding.launchId
    && proof.childPid === binding.childPid
    && proof.provider === binding.profile.provider
    && proof.model === binding.profile.model
    && proof.api === binding.profile.api
    && proof.settingsFingerprint === binding.settingsFingerprint
    && proof.configFingerprint === binding.configFingerprint
    && proof.profileFingerprint === binding.profileFingerprint
    && proof.profileFingerprint === memoryRuntimeProfileFingerprint(binding.profile)
    && proof.adapterVersion === binding.profile.adapterVersion
    && typeof proof.proofId === "string" && proof.proofId.length > 0
    && typeof proof.taskId === "string" && proof.taskId.length > 0
    && typeof proof.assemblyHash === "string" && /^[a-f0-9]{64}$/u.test(proof.assemblyHash);
}

export function memoryRuntimeGenerationIdentity(proof: MemoryCapabilityProof): string {
  return [
    proof.launchId,
    proof.childPid,
    proof.proofId,
    proof.settingsFingerprint,
    proof.configFingerprint,
    proof.profileFingerprint,
    proof.adapterVersion,
  ].join("\0");
}

export function memoryRuntimeGenerationFromState(state: OpenVikingRuntimeState | undefined): string | undefined {
  if (!state?.requestReady || !state.childPid || !state.activeProfile || !state.activeProfileFingerprint
    || !state.activeSettingsFingerprint || !state.activeConfigFingerprint || !state.memoryCapability) return undefined;
  const binding: MemoryCapabilityBinding = {
    launchId: state.launchId,
    childPid: state.childPid,
    settingsFingerprint: state.activeSettingsFingerprint,
    configFingerprint: state.activeConfigFingerprint,
    profile: state.activeProfile,
    profileFingerprint: state.activeProfileFingerprint,
  };
  return memoryCapabilityMatches(state.memoryCapability, binding)
    ? memoryRuntimeGenerationIdentity(state.memoryCapability)
    : undefined;
}
