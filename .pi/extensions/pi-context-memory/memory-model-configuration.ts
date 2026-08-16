import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { chmod, link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  createMemoryRuntimeProfile,
  memoryRuntimeProfileFingerprint,
  type MemoryRuntimeProfile,
} from "./memory-runtime-profile.ts";
import type { MemoryCapabilityProof } from "./memory-runtime-capability.ts";

export const OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS = 15_000;
export const DEFAULT_OPENVIKING_READINESS_TIMEOUT_MS = 30_000;
export const DEFAULT_OPENVIKING_STOP_TIMEOUT_MS = 5_000;
export const OPENVIKING_CONTROL_REQUEST_GRACE_MS = 5_000;
export const DEFAULT_OPENVIKING_OPERATION_TIMEOUT_MS = OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS
  + (4 * DEFAULT_OPENVIKING_STOP_TIMEOUT_MS)
  + DEFAULT_OPENVIKING_READINESS_TIMEOUT_MS
  + OPENVIKING_CONTROL_REQUEST_GRACE_MS;
export const OPENVIKING_RUNTIME_SCHEMA_VERSION = 2 as const;
export const MEMORY_MODEL_CONFIG_FILENAME = "pi-context-memory.jsonc";
export const OPENVIKING_MEMORY_API_KEY_ENV = "PCR_OPENVIKING_MEMORY_API_KEY";
export const OPENVIKING_MEMORY_API_KEY_REFERENCE = `\${${OPENVIKING_MEMORY_API_KEY_ENV}}`;
export const COMPILED_OPENVIKING_CREDENTIAL = Symbol("compiled-openviking-credential");
const MEMORY_MODEL_CREDENTIAL_ENV_REFERENCE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

export function memoryModelCredentialEnvironmentVariable(apiKey: unknown): string | undefined {
  if (typeof apiKey !== "string") return undefined;
  const match = MEMORY_MODEL_CREDENTIAL_ENV_REFERENCE.exec(apiKey);
  return match ? match[1] ?? match[2] : undefined;
}


export interface MemoryModelSetting {
  provider: string;
  model: string;
  api_key?: string;
  api_base?: string;
  api_version?: string;
}

export interface MemoryModelCapabilities {
  openVikingVersion: string;
  settingFields: Record<string, unknown>;
  vlmSchemaSha256: string;
}

export interface CompiledOpenVikingConfig {
  config: Record<string, unknown>;
  provider: string;
  model: string;
  settingsFingerprint: string;
  configFingerprint: string;
  profile: MemoryRuntimeProfile;
  profileFingerprint: string;
  credentialEnvironmentVariable?: string | null;
  [COMPILED_OPENVIKING_CREDENTIAL]?: {
    value: string;
  };
}
export interface ValidatedMemoryModelConfiguration {
  setting: MemoryModelSetting;
  compiled: CompiledOpenVikingConfig;
}

export interface OpenVikingLauncherInfo {
  schemaVersion: typeof OPENVIKING_RUNTIME_SCHEMA_VERSION;
  launchId: string;
  launcherPid: number;
  controlUrl: string;
  operationTimeoutMs: number;
}

export interface OpenVikingRuntimeState {
  schemaVersion: typeof OPENVIKING_RUNTIME_SCHEMA_VERSION;
  launchId: string;
  launcherPid: number;
  operationId?: string;
  childPid?: number;
  phase: "starting" | "ready" | "restarting" | "failed" | "stopped";
  ready: boolean;
  serviceReady: boolean;
  requestReady: boolean;
  activeProvider?: string;
  activeModel?: string;
  activeSettingsFingerprint?: string;
  activeConfigFingerprint?: string;
  activeProfile?: MemoryRuntimeProfile;
  activeProfileFingerprint?: string;
  memoryCapability?: MemoryCapabilityProof;
  targetProvider?: string;
  targetModel?: string;
  targetSettingsFingerprint?: string;
  targetConfigFingerprint?: string;
  targetProfileFingerprint?: string;
  configurationError?: string;
  error?: string;
}

export interface RuntimePaths {
  root: string;
  baseConfig: string;
  settings: string;
  runtimeDir: string;
  generatedConfig: string;
  launcherInfo: string;
  state: string;
  lifecycleLock: string;
}

export class MemoryModelConfigurationError extends Error {
  readonly configPath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(configPath: string, message: string, line?: number, column?: number) {
    super(`Invalid memory model configuration at ${configPath}${line && column ? `:${line}:${column}` : ""}: ${message}`);
    this.name = "MemoryModelConfigurationError";
    this.configPath = configPath;
    this.line = line;
    this.column = column;
  }
}

function environmentPath(root: string, value: string | undefined, fallback: string): string {
  if (!value) return join(root, fallback);
  return isAbsolute(value) ? value : resolve(root, value);
}

function memoryModelHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

export function memoryModelConfigPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.PCR_MEMORY_MODEL_SETTINGS
    ? environmentPath(root, env.PCR_MEMORY_MODEL_SETTINGS, "")
    : join(memoryModelHome(env), ".pi", MEMORY_MODEL_CONFIG_FILENAME);
}

export async function locateProjectRoot(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    try {
      await readFile(join(current, "scripts", "openviking-config.py"));
      await readFile(join(current, "config", "openviking.json"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot locate the pi-context-memory project root from ${start}`);
      current = parent;
    }
  }
}

export function runtimePaths(root: string, env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const runtimeDir = environmentPath(root, env.PCR_OPENVIKING_RUNTIME_DIR, ".artifacts/openviking/runtime");
  const runtimePath = (value: string | undefined, name: string) => value
    ? environmentPath(root, value, join(".artifacts/openviking/runtime", name))
    : join(runtimeDir, name);
  return {
    root,
    baseConfig: environmentPath(root, env.PCR_OPENVIKING_BASE_CONFIG, "config/openviking.json"),
    settings: memoryModelConfigPath(root, env),
    runtimeDir,
    generatedConfig: runtimePath(env.PCR_OPENVIKING_GENERATED_CONFIG, "openviking.json"),
    launcherInfo: runtimePath(env.PCR_OPENVIKING_LAUNCHER_INFO, "launcher.json"),
    state: runtimePath(env.PCR_OPENVIKING_STATE, "state.json"),
    lifecycleLock: runtimePath(env.PCR_OPENVIKING_LIFECYCLE_LOCK, "launcher.lock"),
  };
}

export function openVikingServerAddress(config: unknown): { host: string; port: number } {
  const server = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).server
    : undefined;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("OpenViking configuration requires a server section");
  }
  const { host, port } = server as Record<string, unknown>;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("The project launcher only manages a loopback OpenViking server");
  }
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("OpenViking server.port must be an integer between 1 and 65535");
  }
  return { host, port: port as number };
}

export function configuredOpenVikingBaseUrl(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.PCR_OPENVIKING_URL?.trim();
  if (override) return override;
  const config = JSON.parse(readFileSync(runtimePaths(root, env).baseConfig, "utf8")) as unknown;
  const { host, port } = openVikingServerAddress(config);
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = join(dirname(path), `.${randomUUID()}.pending`);
  try {
    await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(pending, 0o600);
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

function runBridge<T>(
  root: string,
  command: "describe" | "compile",
  input?: unknown,
): Promise<T> {
  const python = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
  const script = join(root, "scripts", "openviking-config.py");
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(python, [script, command], {
      cwd: root,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        let message = diagnostic || `OpenViking configuration bridge exited with ${code ?? signal ?? "unknown"}`;
        try {
          const parsed = JSON.parse(diagnostic) as { error?: unknown };
          if (typeof parsed.error === "string") message = parsed.error;
        } catch {
          // Preserve the bridge diagnostic when it is not JSON.
        }
        rejectResult(new Error(message));
        return;
      }
      try {
        resolveResult(JSON.parse(output) as T);
      } catch {
        rejectResult(new Error("OpenViking configuration bridge returned invalid JSON"));
      }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

const capabilityCache = new Map<string, Promise<MemoryModelCapabilities>>();

export function describeMemoryModelCapabilities(
  root: string,
): Promise<MemoryModelCapabilities> {
  const key = resolve(root);
  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const loading = runBridge<MemoryModelCapabilities>(key, "describe");
  capabilityCache.set(key, loading);
  void loading.catch(() => capabilityCache.delete(key));
  return loading;
}

function memoryModelTemplate(capabilities: MemoryModelCapabilities): string {
  return [
    "{",
    `  // Provider、模型和连接字段来自当前 OpenViking ${capabilities.openVikingVersion} 的 VLM schema。`,
    "  // OpenViking 配置加载和当前受管进程的真实能力探针共同决定精确配置是否可用。",
    "  // api_key 可直接填写 key，或用 $NAME / ${NAME} 引用启动器环境变量；省略时不注入凭据。",
    "  // api_base 与 api_version 仅在目标 Provider 需要时填写。",
    "  // 本文件包含直接 key 时必须保持仅当前用户可读写。",
    "  // 保存有效配置后，在 Pi 中执行 /restart-viking。",
    "  \"memoryModel\": null,",
    "",
    "  // 示例：",
    "  // \"memoryModel\": {",
    "  //   \"provider\": \"<openviking-provider>\",",
    "  //   \"model\": \"<model-id-or-route>\",",
    "  //   \"api_key\": \"$PROVIDER_API_KEY\",",
    "  //   \"api_base\": \"https://<service-endpoint>\",",
    "  //   \"api_version\": \"<api-version>\"",
    "  // }",
    "}",
    "",
  ].join("\n");
}

export async function ensureMemoryModelConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configPath = memoryModelConfigPath(root, env);
  try {
    await readFile(configPath, "utf8");
    await chmod(configPath, 0o600);
    return configPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const capabilities = await describeMemoryModelCapabilities(root);
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = join(directory, `.${randomUUID()}.pending`);
  try {
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(memoryModelTemplate(capabilities), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(pending, 0o600);
    try {
      await link(pending, configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(pending, { force: true });
  }
  return configPath;
}

export async function normalizeMemoryModelSetting(
  root: string,
  setting: unknown,
): Promise<MemoryModelSetting> {
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    throw new Error("Memory model setting must be a JSON object");
  }
  const value = setting as Record<string, unknown>;
  const capabilities = await describeMemoryModelCapabilities(root);
  const knownFields = new Set(Object.keys(capabilities.settingFields));
  const unknown = Object.keys(value).filter((field) => !knownFields.has(field)).sort();
  if (unknown.length > 0) throw new Error(`Unknown memory model setting fields: ${unknown.join(", ")}`);
  const provider = typeof value.provider === "string" ? value.provider.trim().toLowerCase() : "";
  if (!provider) throw new Error("Memory model provider is required");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) throw new Error("Memory model ID is required");

  const normalized: MemoryModelSetting = { provider, model };
  const apiKey = value.api_key;
  if (apiKey !== undefined && apiKey !== "") {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("api_key must be a non-empty string");
    normalized.api_key = apiKey.trim();
  }
  for (const field of ["api_base", "api_version"] as const) {
    const input = value[field];
    if (input === undefined || input === "") continue;
    if (typeof input !== "string" || !input.trim()) throw new Error(`${field} must be a non-empty string`);
    normalized[field] = field === "api_base" ? input.trim().replace(/\/+$/, "") : input.trim();
  }
  return normalized;
}

function lineAndColumn(source: string, position: number): { line: number; column: number } {
  const before = source.slice(0, Math.max(0, position));
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function stripJsoncComments(source: string, configPath: string): string {
  const output = source.split("");
  if (output[0] === "\uFEFF") output[0] = " ";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "/" || output[index + 1] === undefined) continue;
    if (output[index + 1] === "/") {
      output[index] = output[index + 1] = " ";
      index += 2;
      while (index < output.length && output[index] !== "\n" && output[index] !== "\r") {
        output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (output[index + 1] === "*") {
      const start = index;
      output[index] = output[index + 1] = " ";
      index += 2;
      let closed = false;
      while (index < output.length) {
        if (output[index] === "*" && output[index + 1] === "/") {
          output[index] = output[index + 1] = " ";
          index += 1;
          closed = true;
          break;
        }
        if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
        index += 1;
      }
      if (!closed) {
        const location = lineAndColumn(source, start);
        throw new MemoryModelConfigurationError(configPath, "Unterminated block comment", location.line, location.column);
      }
    }
  }
  return output.join("");
}

function removeTrailingCommas(source: string): string {
  const output = source.split("");
  let inString = false;
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== ",") continue;
    let next = index + 1;
    while (next < output.length && /\s/.test(output[next])) next += 1;
    if (output[next] === "}" || output[next] === "]") output[index] = " ";
  }
  return output.join("");
}

function parseMemoryModelJsonc(source: string, configPath: string): unknown {
  try {
    const normalized = removeTrailingCommas(stripJsoncComments(source, configPath));
    return normalized.trim() ? JSON.parse(normalized) : {};
  } catch (error) {
    if (error instanceof MemoryModelConfigurationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = message.match(/position\s+(\d+)/i);
    const lineMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    const location = positionMatch
      ? lineAndColumn(source, Number(positionMatch[1]))
      : lineMatch
        ? { line: Number(lineMatch[1]), column: Number(lineMatch[2]) }
        : { line: 1, column: 1 };
    throw new MemoryModelConfigurationError(configPath, "JSONC syntax error", location.line, location.column);
  }
}


export async function readMemoryModelSetting(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelSetting | undefined> {
  const configPath = await ensureMemoryModelConfig(root, env);
  const source = await readFile(configPath, "utf8");
  const parsed = parseMemoryModelJsonc(source, configPath);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryModelConfigurationError(configPath, "The file root must be an object", 1, 1);
  }
  const config = parsed as Record<string, unknown>;
  const unknown = Object.keys(config).filter((field) => field !== "memoryModel").sort();
  if (unknown.length > 0) {
    throw new MemoryModelConfigurationError(configPath, `Unknown root fields: ${unknown.join(", ")}`, 1, 1);
  }
  if (config.memoryModel === undefined || config.memoryModel === null) return undefined;
  try {
    return await normalizeMemoryModelSetting(root, config.memoryModel);
  } catch (error) {
    const position = Math.max(0, source.indexOf('"memoryModel"'));
    const location = lineAndColumn(source, position);
    throw new MemoryModelConfigurationError(
      configPath,
      `memoryModel: ${error instanceof Error ? error.message : String(error)}`,
      location.line,
      location.column,
    );
  }
}

export async function validateMemoryModelConfiguration(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidatedMemoryModelConfiguration | undefined> {
  const setting = await readMemoryModelSetting(root, env);
  if (!setting) return undefined;
  try {
    return { setting, compiled: await compileOpenVikingConfig(root, setting, env) };
  } catch (error) {
    throw new MemoryModelConfigurationError(
      memoryModelConfigPath(root, env),
      `memoryModel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function validateMemoryModelSetting(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelSetting | undefined> {
  return readMemoryModelSetting(root, env);
}

export async function memoryModelConfigContentFingerprint(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(memoryModelConfigPath(root, env), "utf8")).digest("hex");
  } catch {
    return undefined;
  }
}

export async function compileOpenVikingConfig(
  root: string,
  setting: MemoryModelSetting,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CompiledOpenVikingConfig> {
  const paths = runtimePaths(root, env);
  const baseConfig = await readJson(paths.baseConfig);
  const credentialEnvironmentVariable = memoryModelCredentialEnvironmentVariable(setting.api_key);
  let credentialValue = setting.api_key;
  if (credentialEnvironmentVariable) {
    credentialValue = env[credentialEnvironmentVariable];
    if (!credentialValue || !credentialValue.trim()) {
      throw new Error(`api_key references unset environment variable ${credentialEnvironmentVariable}`);
    }
  }
  const profile = createMemoryRuntimeProfile(setting.provider, setting.model);
  const profileFingerprint = memoryRuntimeProfileFingerprint(profile);
  const compiled = await runBridge<CompiledOpenVikingConfig>(root, "compile", {
    baseConfig,
    setting: credentialValue ? { ...setting, api_key: credentialValue } : setting,
    runtimeProfile: profile,
  });
  if (compiled.profileFingerprint !== profileFingerprint
    || JSON.stringify(compiled.profile) !== JSON.stringify(profile)) {
    throw new Error("OpenViking configuration bridge returned a different MemoryRuntimeProfile");
  }
  compiled.settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(setting).sort(([left], [right]) => left.localeCompare(right)))))
    .digest("hex");
  compiled.credentialEnvironmentVariable = credentialEnvironmentVariable ?? null;
  if (credentialValue) {
    Object.defineProperty(compiled, COMPILED_OPENVIKING_CREDENTIAL, {
      value: { value: credentialValue },
      enumerable: false,
    });
  }
  return compiled;
}

export async function readLauncherInfo(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenVikingLauncherInfo | undefined> {
  const paths = runtimePaths(root, env);
  const launcher = await readOptionalJson(paths.launcherInfo) as OpenVikingLauncherInfo | undefined;
  if (!launcher) return undefined;
  const lock = await readOptionalJson(paths.lifecycleLock) as { schemaVersion?: number; launchId?: string; launcherPid?: number } | undefined;
  if (!lock) return undefined;
  if (launcher.schemaVersion !== OPENVIKING_RUNTIME_SCHEMA_VERSION
    || lock.schemaVersion !== OPENVIKING_RUNTIME_SCHEMA_VERSION) return undefined;
  if (launcher.launchId !== lock.launchId || launcher.launcherPid !== lock.launcherPid) return undefined;
  return processAlive(launcher.launcherPid) ? launcher : undefined;
}

function processAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readRuntimeState(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenVikingRuntimeState | undefined> {
  const paths = runtimePaths(root, env);
  const launcher = await readOptionalJson(paths.launcherInfo) as OpenVikingLauncherInfo | undefined;
  if (!launcher) return undefined;
  const [state, lock] = await Promise.all([
    readOptionalJson(paths.state) as Promise<OpenVikingRuntimeState | undefined>,
    readOptionalJson(paths.lifecycleLock) as Promise<{ schemaVersion?: number; launchId?: string; launcherPid?: number } | undefined>,
  ]);
  if (!state || !lock) return undefined;
  if (launcher.schemaVersion !== OPENVIKING_RUNTIME_SCHEMA_VERSION
    || state.schemaVersion !== OPENVIKING_RUNTIME_SCHEMA_VERSION
    || lock.schemaVersion !== OPENVIKING_RUNTIME_SCHEMA_VERSION) return undefined;
  if (launcher.launchId !== state.launchId || launcher.launchId !== lock.launchId) return undefined;
  if (launcher.launcherPid !== state.launcherPid || launcher.launcherPid !== lock.launcherPid) return undefined;
  if (!processAlive(launcher.launcherPid)) return undefined;
  if (state.childPid && !processAlive(state.childPid)) {
    return {
      ...state,
      phase: "failed",
      ready: false,
      serviceReady: false,
      requestReady: false,
      childPid: undefined,
      activeProvider: undefined,
      activeModel: undefined,
      activeSettingsFingerprint: undefined,
      activeConfigFingerprint: undefined,
      activeProfile: undefined,
      activeProfileFingerprint: undefined,
      memoryCapability: undefined,
      error: "Managed OpenViking process is not running",
    };
  }
  return state;
}

function postLoopbackJson(url: URL, body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolveResponse, rejectResponse) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      response.setEncoding("utf8");
      response.once("error", rejectResponse);
      response.once("aborted", () => rejectResponse(new Error("OpenViking launcher response was aborted")));
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
        if (Buffer.byteLength(responseBody, "utf8") > 1_048_576) request.destroy(new Error("OpenViking launcher response exceeded 1 MiB"));
      });
      response.once("end", () => resolveResponse({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("OpenViking restart request timed out")));
    request.once("error", rejectResponse);
    request.end(payload);
  });
}
export async function requestOpenVikingRestart(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenVikingRuntimeState> {
  const launcher = await readLauncherInfo(root, env);
  if (!launcher) throw new Error("OpenViking launcher is not running. Start it with: node scripts/start-openviking.mjs");
  const controlUrl = new URL(launcher.controlUrl);
  if (controlUrl.protocol !== "http:" || controlUrl.hostname !== "127.0.0.1") {
    throw new Error("OpenViking launcher control URL must use loopback HTTP");
  }
  const operationTimeoutMs = Number.isSafeInteger(launcher.operationTimeoutMs) && launcher.operationTimeoutMs > 0
    ? launcher.operationTimeoutMs
    : DEFAULT_OPENVIKING_OPERATION_TIMEOUT_MS;
  const operationId = randomUUID();
  let response: { status: number; body: string };
  try {
    response = await postLoopbackJson(
      new URL("/restart", controlUrl),
      { launchId: launcher.launchId, operationId },
      operationTimeoutMs + OPENVIKING_CONTROL_REQUEST_GRACE_MS,
    );
  } catch (error) {
    const state = await readRuntimeState(root, env);
    if (state?.operationId === operationId && state.phase === "ready" && state.ready) return state;
    if (state?.operationId === operationId && state.phase === "failed" && state.error) throw new Error(state.error);
    throw error;
  }
  let body: { state?: OpenVikingRuntimeState; error?: string } | undefined;
  try {
    body = JSON.parse(response.body) as typeof body;
  } catch {
    body = undefined;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(body?.error ?? `OpenViking restart failed with HTTP ${response.status}`);
  }
  if (!body?.state) throw new Error("OpenViking launcher returned no runtime state");
  return body.state;
}

export function memoryModelSettingsFingerprint(setting: MemoryModelSetting): string {
  const sorted = Object.fromEntries(Object.entries(setting).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
