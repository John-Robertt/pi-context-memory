import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chmod, link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MEMORY_MODEL_CREDENTIAL_ENV = "PCR_OPENVIKING_VLM_API_KEY";
export const OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS = 15_000;
export const MEMORY_MODEL_CONFIG_FILENAME = "pi-context-memory.jsonc";

export interface MemoryModelSetting {
  provider: string;
  model: string;
  api_base?: string;
  api_version?: string;
}

export interface ProviderCapability {
  name: string;
  required: string[];
  optional: string[];
  credential: "environment" | "environment-or-native" | "optional-environment-or-native";
}

export interface LiteLLMRouteCapabilities {
  catalogUrl: string;
  recognized: Array<{
    source: string;
    modelPatterns: string[];
    keywords: string[];
    credentialEnvironment: string;
  }>;
  specialModelPatterns: Array<{ source: string; modelPattern: string }>;
  explicit: Array<{ prefix: string; nativeAuthentication: boolean }>;
  customOpenAICompatible: { modelPattern: string; apiBaseRequired: boolean };
}
export interface MemoryModelCapabilities {
  openVikingVersion: string;
  providers: ProviderCapability[];
  settingFields: Record<string, unknown>;
  vlmSchemaSha256: string;
  credentialEnvironment: string;
  litellmRoutes: LiteLLMRouteCapabilities;
}

export interface CompiledOpenVikingConfig {
  config: Record<string, unknown>;
  provider: string;
  model: string;
  settingsFingerprint: string;
  configFingerprint: string;
}

export interface OpenVikingLauncherInfo {
  schemaVersion: 1;
  launchId: string;
  launcherPid: number;
  controlUrl: string;
  operationTimeoutMs: number;
}

export interface OpenVikingRuntimeState {
  schemaVersion: 1;
  launchId: string;
  launcherPid: number;
  operationId?: string;
  childPid?: number;
  phase: "starting" | "ready" | "restarting" | "failed" | "stopped";
  ready: boolean;
  activeProvider?: string;
  activeModel?: string;
  activeSettingsFingerprint?: string;
  activeConfigFingerprint?: string;
  targetProvider?: string;
  targetModel?: string;
  targetSettingsFingerprint?: string;
  targetConfigFingerprint?: string;
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const python = process.platform === "win32"
    ? join(root, ".venv", "Scripts", "python.exe")
    : join(root, ".venv", "bin", "python");
  const script = join(root, "scripts", "openviking-config.py");
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(python, [script, command], {
      cwd: root,
      env,
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelCapabilities> {
  const key = resolve(root);
  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const loading = runBridge<MemoryModelCapabilities>(key, "describe", undefined, env);
  capabilityCache.set(key, loading);
  void loading.catch(() => capabilityCache.delete(key));
  return loading;
}

function appendLiteLLMRouteComments(lines: string[], routes: LiteLLMRouteCapabilities): void {
  lines.push("  // LiteLLM 是多来源路由层，model 使用 <litellm-provider>/<model-id>，不是固定来源的模型名。");
  lines.push(`  // 更多 LiteLLM 格式参考：${routes.catalogUrl}（未列路由不属于当前模板保证范围）`);
  lines.push("  // backend 按下列顺序扫描整个模型字符串的关键词；请优先使用明确前缀以避免误识别。");
  lines.push("  // OpenViking 内置识别并补全的来源：");
  for (const route of routes.recognized) {
    lines.push(`  //   ${route.source}: ${route.modelPatterns.join(" 或 ")}；关键词 ${route.keywords.join(", ")}；凭据变量 ${route.credentialEnvironment}（按来源需要）`);
  }
  for (const route of routes.specialModelPatterns) {
    lines.push(`  //   ${route.source} 特殊模型格式：${route.modelPattern}`);
  }
  lines.push("  // OpenViking 保持原样的显式路由：");
  for (const route of routes.explicit) {
    lines.push(`  //   ${route.prefix}/<model-id>${route.nativeAuthentication ? "（使用云原生凭据）" : ""}`);
  }
  lines.push(`  // 自定义 OpenAI-compatible：model 为 ${routes.customOpenAICompatible.modelPattern}，并填写 api_base。`);
}
function memoryModelTemplate(capabilities: MemoryModelCapabilities): string {
  const lines = [
    "{",
    "  // 从下方选择一个 Provider 示例，用对应对象替换 null。",
    "  // 凭据不要写入本文件；请使用说明中的环境变量或原生认证。",
    "  // 保存有效配置后，在 Pi 中执行 /restart-viking 应用。",
    "  \"memoryModel\": null,",
    "",
    `  // OpenViking ${capabilities.openVikingVersion} 支持的 VLM Provider：`,
  ];
  for (const provider of capabilities.providers) {
    const model = provider.name === "azure" ? "<deployment-name>" : provider.name === "litellm" ? "<litellm-provider>/<model-id>" : "<model-id>";
    const credential = provider.name === "litellm"
      ? `${MEMORY_MODEL_CREDENTIAL_ENV} 可用于 API-key 来源；未设置时由 LiteLLM 读取来源自己的环境变量或云原生凭据`
      : provider.credential === "environment"
        ? `通过 ${MEMORY_MODEL_CREDENTIAL_ENV} 环境变量提供`
        : provider.credential === "environment-or-native"
          ? `使用 ${MEMORY_MODEL_CREDENTIAL_ENV} 或 OpenViking 原生认证`
          : `需要时使用 ${MEMORY_MODEL_CREDENTIAL_ENV}，否则使用原生认证`;
    lines.push(`  // ${provider.name}:`);
    if (provider.name === "litellm") appendLiteLLMRouteComments(lines, capabilities.litellmRoutes);
    lines.push("  // {");
    lines.push(`  //   \"provider\": \"${provider.name}\",`);
    lines.push(`  //   \"model\": \"${model}\"${provider.required.length + provider.optional.length > 0 ? "," : ""}`);
    const fields = [...provider.required, ...provider.optional];
    fields.forEach((field, index) => {
      const required = provider.required.includes(field);
      const placeholder = field === "api_base"
        ? provider.name === "litellm" ? "https://<custom-endpoint>" : "https://<service-endpoint>"
        : "<api-version>";
      const fieldNote = provider.name === "litellm" && field === "api_base"
        ? "可选，仅用于自定义端点或要求显式端点的来源"
        : required ? "必填" : "可选";
      lines.push(`  //   \"${field}\": \"${placeholder}\"${index < fields.length - 1 ? "," : ""} // ${fieldNote}`);
    });
    lines.push("  // }");
    lines.push(`  // 认证：${credential}`);
    lines.push("");
  }
  lines.push("}", "");
  return lines.join("\n");
}

export async function ensureMemoryModelConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configPath = memoryModelConfigPath(root, env);
  try {
    await readFile(configPath, "utf8");
    return configPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const capabilities = await describeMemoryModelCapabilities(root, env);
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelSetting> {
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
    throw new Error("Memory model setting must be a JSON object");
  }
  const value = setting as Record<string, unknown>;
  const knownFields = new Set(["provider", "model", "api_base", "api_version"]);
  const unknown = Object.keys(value).filter((field) => !knownFields.has(field)).sort();
  if (unknown.length > 0) throw new Error(`Unknown memory model setting fields: ${unknown.join(", ")}`);

  const capabilities = await describeMemoryModelCapabilities(root, env);
  const provider = typeof value.provider === "string" ? value.provider.trim().toLowerCase() : "";
  const descriptor = capabilities.providers.find((item) => item.name === provider);
  if (!descriptor) throw new Error(provider ? "Unsupported OpenViking VLM provider" : "Memory model provider is required");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) throw new Error("Memory model ID is required");

  const normalized: MemoryModelSetting = { provider, model };
  const acceptedConnections = new Set([...descriptor.required, ...descriptor.optional]);
  for (const field of ["api_base", "api_version"] as const) {
    const input = value[field];
    if (input === undefined || input === "") continue;
    if (!acceptedConnections.has(field)) throw new Error(`${field} is not supported for OpenViking provider ${provider}`);
    if (typeof input !== "string" || !input.trim()) throw new Error(`${field} must be a non-empty string`);
    normalized[field] = field === "api_base" ? input.trim().replace(/\/+$/, "") : input.trim();
  }
  for (const field of descriptor.required) {
    if (!normalized[field as keyof MemoryModelSetting]) throw new Error(`OpenViking provider ${provider} requires ${field}`);
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
    return await normalizeMemoryModelSetting(root, config.memoryModel, env);
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

export async function validateMemoryModelSetting(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemoryModelSetting | undefined> {
  const setting = await readMemoryModelSetting(root, env);
  if (!setting) return undefined;
  try {
    await compileOpenVikingConfig(root, setting, env);
    return setting;
  } catch (error) {
    throw new MemoryModelConfigurationError(
      memoryModelConfigPath(root, env),
      `memoryModel: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  return runBridge(root, "compile", {
    baseConfig,
    setting,
    credentialAvailable: Boolean(env[MEMORY_MODEL_CREDENTIAL_ENV]?.trim()),
  }, env);
}

export async function readLauncherInfo(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenVikingLauncherInfo | undefined> {
  const paths = runtimePaths(root, env);
  const launcher = await readOptionalJson(paths.launcherInfo) as OpenVikingLauncherInfo | undefined;
  if (!launcher) return undefined;
  const lock = await readOptionalJson(paths.lifecycleLock) as { launchId?: string; launcherPid?: number } | undefined;
  if (!lock) return undefined;
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
    readOptionalJson(paths.lifecycleLock) as Promise<{ launchId?: string; launcherPid?: number } | undefined>,
  ]);
  if (!state || !lock) return undefined;
  if (launcher.launchId !== state.launchId || launcher.launchId !== lock.launchId) return undefined;
  if (launcher.launcherPid !== state.launcherPid || launcher.launcherPid !== lock.launcherPid) return undefined;
  if (!processAlive(launcher.launcherPid)) return undefined;
  if (state.ready && !processAlive(state.childPid)) {
    return {
      ...state,
      phase: "failed",
      ready: false,
      childPid: undefined,
      activeProvider: undefined,
      activeModel: undefined,
      activeSettingsFingerprint: undefined,
      activeConfigFingerprint: undefined,
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
    : 70_000;
  const operationId = randomUUID();
  let response: { status: number; body: string };
  try {
    response = await postLoopbackJson(
      new URL("/restart", controlUrl),
      { launchId: launcher.launchId, operationId },
      operationTimeoutMs + 5_000,
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
