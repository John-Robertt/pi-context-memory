import { createHash } from "node:crypto";

export const MEMORY_RUNTIME_PROFILE_VERSION = 2 as const;
export const MEMORY_RUNTIME_ADAPTER_VERSION = "openviking-session-memory-v1" as const;
export const MEMORY_RUNTIME_REQUEST_TIMEOUT_MS = 180_000;
export interface MemoryRuntimeProfile {
  profileVersion: typeof MEMORY_RUNTIME_PROFILE_VERSION;
  provider: string;
  model: string;
  api: "openviking-vlm";
  thinking: false;
  temperature: 0;
  stream: false;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  adapterVersion: typeof MEMORY_RUNTIME_ADAPTER_VERSION;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

export function memoryRuntimeProfileFingerprint(profile: MemoryRuntimeProfile): string {
  return createHash("sha256").update(JSON.stringify(stable(profile))).digest("hex");
}

export function createMemoryRuntimeProfile(provider: string, model: string): MemoryRuntimeProfile {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim();
  if (!normalizedProvider || !normalizedModel) throw new Error("Memory runtime profile requires Provider and model");
  return {
    profileVersion: MEMORY_RUNTIME_PROFILE_VERSION,
    provider: normalizedProvider,
    model: normalizedModel,
    api: "openviking-vlm",
    thinking: false,
    temperature: 0,
    stream: false,
    maxOutputTokens: 4_096,
    requestTimeoutMs: MEMORY_RUNTIME_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    maxConcurrency: 1,
    adapterVersion: MEMORY_RUNTIME_ADAPTER_VERSION,
  };
}

export function assertMemoryRuntimeProfile(value: unknown): asserts value is MemoryRuntimeProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory runtime profile is invalid");
  const profile = value as Record<string, unknown>;
  const expected = createMemoryRuntimeProfile(String(profile.provider ?? ""), String(profile.model ?? ""));
  if (JSON.stringify(stable(profile)) !== JSON.stringify(stable(expected))) {
    throw new Error("Memory runtime profile does not match the supported policy");
  }
}
