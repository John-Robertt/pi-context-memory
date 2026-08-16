#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWriteJson,
  COMPILED_OPENVIKING_CREDENTIAL,
  compileOpenVikingConfig,
  OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS,
  OPENVIKING_RUNTIME_SCHEMA_VERSION,
  OPENVIKING_MEMORY_API_KEY_ENV,
  OPENVIKING_MEMORY_API_KEY_REFERENCE,
  describeMemoryModelCapabilities,
  ensureMemoryModelConfig,
  memoryModelConfigContentFingerprint,
  memoryModelConfigPath,
  readLauncherInfo,
  readMemoryModelSetting,
  readRuntimeState,
  requestOpenVikingRestart,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import { MEMORY_RUNTIME_REQUEST_TIMEOUT_MS } from "../.pi/extensions/pi-context-memory/memory-runtime-profile.ts";
import {
  memoryCapabilityMatches,
  memoryRuntimeGenerationIdentity,
} from "../.pi/extensions/pi-context-memory/memory-runtime-capability.ts";
import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import {
  assertValidationPiVersion,
  createIsolatedPiProviderCredential,
  readProjectOpenVikingVersion,
  readValidationSuite,
} from "./validation-suite.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-memory-model-runtime.mjs");
const piVersion = assertValidationPiVersion(root);
const expectedOpenVikingVersion = readProjectOpenVikingVersion(root);
const validationSuite = readValidationSuite(root);
const adapterContract = JSON.parse(readFileSync(join(root, "config/openviking-adapter-contract.json"), "utf8"));
if (adapterContract?.schemaVersion !== 1 || !Array.isArray(adapterContract.providers)) {
  throw new Error("OpenViking adapter contract is invalid");
}
const expectedProviders = adapterContract.providers.map((descriptor) => descriptor.name);
const pythonCommand = process.platform === "win32"
  ? join(root, ".venv/Scripts/python.exe")
  : join(root, ".venv/bin/python");
const runId = process.env.PCR_RUN_ID ?? `memory-model-runtime-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const artifactRoot = join(root, ".artifacts/memory-model-runtime", runId);
const evidencePath = join(root, "validation/evidence/memory-model-runtime.json");
const implementation = captureImplementationEvidence(root, "memory-model-runtime");
const VALIDATION_API_KEY_ENV = "MEMORY_MODEL_RUNTIME_API_KEY";
const VALIDATION_API_KEY_REFERENCE = `$${VALIDATION_API_KEY_ENV}`;
const VALIDATION_API_KEY_BRACED_REFERENCE = `\${${VALIDATION_API_KEY_ENV}}`;
const VALIDATION_API_KEY = "validation-only-not-a-provider-key";
const SECOND_VALIDATION_API_KEY_ENV = "MEMORY_MODEL_RUNTIME_SECOND_API_KEY";
const SECOND_VALIDATION_API_KEY_REFERENCE = `$${SECOND_VALIDATION_API_KEY_ENV}`;
const SECOND_VALIDATION_API_KEY = "second-validation-only-not-a-provider-key";
const DIRECT_VALIDATION_API_KEY = "direct-validation-only-not-a-provider-key";
const AMBIENT_OPENROUTER_SENTINEL = "ambient-openrouter-must-not-reach-child";
const UNRELATED_PROVIDER_API_KEY_ENV = "ANTHROPIC_API_KEY";
const UNRELATED_PROVIDER_SENTINEL = "unrelated-provider-must-not-reach-child";
mkdirSync(artifactRoot, { recursive: true });

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeMemoryModelConfig(path, setting, includeCredential = true) {
  const credentialRequired = setting
    && setting.provider !== "openai-codex"
    && (setting.provider !== "litellm" || setting.model?.toLowerCase().startsWith("openrouter/"));
  const configured = credentialRequired && includeCredential && !setting.api_key
    ? { ...setting, api_key: VALIDATION_API_KEY_REFERENCE }
    : setting;
  await atomicWriteJson(path, { memoryModel: configured });
}

function supportedMemorySetting(options = {}) {
  const setting = {
    provider: validationSuite.models.memoryProvider,
    model: validationSuite.models.memoryRoute,
  };
  if (options.scenario) setting.api_key = `validation-scenario:${options.scenario}`;
  else if (options.apiKey !== undefined) setting.api_key = options.apiKey;
  return setting;
}
function replaceJson(path, value) {
  const pending = `${path}.pending`;
  writeJson(pending, value);
  renameSync(pending, path);
}

async function expectFailure(action) {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`Process ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate validation port");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function baseConfig(port, workspace) {
  const config = JSON.parse(readFileSync(join(root, "config/openviking.json"), "utf8"));
  config.storage.workspace = workspace;
  config.server.port = port;
  return config;
}

function validationEnvironment(caseDir, baseConfigPath, fakeServer) {
  return {
    ...process.env,
    PCR_OPENVIKING_BASE_CONFIG: baseConfigPath,
    PCR_MEMORY_MODEL_SETTINGS: join(caseDir, "pi-context-memory.jsonc"),
    PCR_OPENVIKING_RUNTIME_DIR: join(caseDir, "runtime"),
    PCR_OPENVIKING_GENERATED_CONFIG: join(caseDir, "runtime", "openviking.json"),
    PCR_OPENVIKING_LAUNCHER_INFO: join(caseDir, "runtime", "launcher.json"),
    PCR_OPENVIKING_STATE: join(caseDir, "runtime", "state.json"),
    PCR_OPENVIKING_SERVER: fakeServer,
    PCR_OPENVIKING_CHILD_ENV_REPORT: join(caseDir, "child-environment.json"),
    [VALIDATION_API_KEY_ENV]: VALIDATION_API_KEY,
    [SECOND_VALIDATION_API_KEY_ENV]: SECOND_VALIDATION_API_KEY,
    OPENROUTER_API_KEY: AMBIENT_OPENROUTER_SENTINEL,
    [UNRELATED_PROVIDER_API_KEY_ENV]: UNRELATED_PROVIDER_SENTINEL,
    PCR_OPENVIKING_READINESS_TIMEOUT_MS: "1200",
    PCR_OPENVIKING_STOP_TIMEOUT_MS: "800",
    PCR_OPENVIKING_CHILD_STDIO: "capture",
  };
}

function createFakeServer(path) {
  writeFileSync(path, `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const model = config.vlm?.model ?? "source-recall-only";
const credential = process.env[${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}] ?? "";
const scenario = credential.startsWith("validation-scenario:")
  ? credential.slice("validation-scenario:".length)
  : model;
if (scenario === "final-direct" || credential === ${JSON.stringify(DIRECT_VALIDATION_API_KEY)}) {
  const credential = process.env[${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}] ?? "";
  const split = Math.max(1, Math.floor(credential.length / 2));
  process.stderr.write(credential.slice(0, split));
  setTimeout(() => process.stderr.write(credential.slice(split)), 10);
}
const childEnvironmentReport = join(dirname(dirname(configPath)), "child-environment.json");
if (childEnvironmentReport) writeFileSync(childEnvironmentReport, JSON.stringify({
  credentialEnvironmentVariablesPresent: ${JSON.stringify([VALIDATION_API_KEY_ENV, SECOND_VALIDATION_API_KEY_ENV])}.filter((name) => Object.hasOwn(process.env, name)),
  internalCredentialPresent: Object.hasOwn(process.env, ${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}),
  internalCredentialSha256: process.env[${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}] ? createHash("sha256").update(process.env[${JSON.stringify(OPENVIKING_MEMORY_API_KEY_ENV)}]).digest("hex") : undefined,
  ambientOpenRouterCredentialPresent: Object.hasOwn(process.env, "OPENROUTER_API_KEY"),
  unrelatedProviderCredentialPresent: Object.hasOwn(process.env, ${JSON.stringify(UNRELATED_PROVIDER_API_KEY_ENV)}),
}));
if (scenario === "exit-early") process.exit(17);
const started = Date.now();
const sessions = new Map();
function send(response, status, result) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    const delayed = scenario === "slow-ready" && Date.now() - started < 500;
    const unavailable = scenario.startsWith("never-ready") || delayed;
    send(response, unavailable ? 503 : 200, { status: unavailable ? "starting" : "ok", healthy: !unavailable, version: ${JSON.stringify(expectedOpenVikingVersion)} });
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
    sessions.set(body.session_id, { messages: [] });
    send(response, 200, { status: "ok", result: { session_id: body.session_id } });
    return;
  }
  const batch = /^\\/api\\/v1\\/sessions\\/([^/]+)\\/messages\\/batch$/.exec(url.pathname);
  if (request.method === "POST" && batch) {
    const session = sessions.get(decodeURIComponent(batch[1]));
    if (!session) { send(response, 404, { status: "error", error: { message: "missing session" } }); return; }
    session.messages.push(...body.messages);
    send(response, 200, { status: "ok", result: { pending_tokens: 100 } });
    return;
  }
  const commit = /^\\/api\\/v1\\/sessions\\/([^/]+)\\/commit$/.exec(url.pathname);
  if (request.method === "POST" && commit) {
    const sessionId = decodeURIComponent(commit[1]);
    if (!sessions.has(sessionId)) { send(response, 404, { status: "error", error: { message: "missing session" } }); return; }
    send(response, 200, { status: "ok", result: { status: "accepted", task_id: "task-" + sessionId } });
    return;
  }
  const task = /^\\/api\\/v1\\/tasks\\/(.+)$/.exec(url.pathname);
  if (request.method === "GET" && task) {
    const taskFails = scenario.startsWith("capability-fail") || scenario === "capability-secret-error";
    send(response, 200, { status: "ok", result: {
      status: taskFails ? "failed" : "completed",
      error: scenario === "capability-secret-error"
        ? "provider echoed " + credential
        : taskFails ? "injected capability failure" : null,
      result: { token_usage: { llm: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } },
    } });
    return;
  }
  const context = /^\\/api\\/v1\\/sessions\\/([^/]+)\\/context$/.exec(url.pathname);
  if (request.method === "GET" && context) {
    const session = sessions.get(decodeURIComponent(context[1]));
    const sourceIds = session?.messages.at(-1)?.source_message_ids ?? [];
    send(response, 200, { status: "ok", result: {
      latest_archive_overview: scenario === "empty-overview" ? "" : "Verified PCM-CAPABILITY-V1 Working Memory overview",
      messages: [{ role: "assistant", content: "Capability probe active history", source_message_ids: sourceIds }],
      estimatedTokens: 32,
    } });
    return;
  }
  const deletion = /^\\/api\\/v1\\/sessions\\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && deletion) {
    if (scenario === "capability-fail-cleanup-fail") {
      send(response, 500, { status: "error", error: { message: "injected cleanup failure" } });
      return;
    }
    sessions.delete(decodeURIComponent(deletion[1]));
    send(response, 200, { status: "ok", result: { session_id: decodeURIComponent(deletion[1]) } });
    return;
  }
  send(response, 404, { status: "error", error: { message: "not found" } });
});
server.listen(config.server.port, config.server.host);
if (scenario.includes("ignore-term")) process.on("SIGTERM", () => undefined);
else process.on("SIGTERM", () => server.close(() => process.exit()));
for (const signal of ["SIGINT", "SIGHUP"]) process.on(signal, () => server.close(() => process.exit()));
`, "utf8");
  chmodSync(path, 0o700);
}

function startLauncher(env) {
  return spawn(process.execPath, [join(root, "scripts/start-openviking.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopLauncher(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.events = [];
    this.buffer = "";
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        this.events.push(event);
        if (event.type === "response" && event.id && this.pending.has(event.id)) {
          this.pending.get(event.id)(event);
          this.pending.delete(event.id);
        }
      }
    });
  }

  send(type, fields = {}) {
    const id = `${type}-${Math.random()}`;
    const result = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`RPC ${type} timed out`));
      }, 30_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        if (!response.success) rejectResponse(new Error(response.error ?? `RPC ${type} failed`));
        else resolveResponse(response);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return result;
  }

  async close() {
    this.child.kill("SIGTERM");
    await waitForExit(this.child, 15_000);
  }
}


async function runPiCommandCase(caseDir, env, commandSequence, expectedWarning) {
  mkdirSync(caseDir, { recursive: true });
  const providerPath = join(caseDir, "local-provider.ts");
  writeFileSync(providerPath, `export default function localProvider(pi) {
  pi.registerProvider("memory-runtime-validation", {
    name: "Memory Runtime Validation",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "local-validation",
    api: "openai-completions",
    models: [{ id: "local", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],
  });
}\n`, "utf8");
  const observationLog = join(caseDir, "observations.jsonl");
  const isolatedHome = join(caseDir, "home");
  const isolatedAgentDir = join(caseDir, "pi-agent");
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(isolatedAgentDir, { recursive: true });
  const child = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--model", "memory-runtime-validation/local",
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--extension", join(root, ".pi/extensions/pi-context-memory/index.ts"),
    "--extension", providerPath,
    "--no-tools",
  ], {
    cwd: root,
    env: {
      ...env,
      HOME: isolatedHome,
      PI_CODING_AGENT_DIR: isolatedAgentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PCR_OBSERVATION_LOG: observationLog,
      PCR_ARCHIVE_DIR: join(caseDir, "archive"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const client = new RpcClient(child);
  await waitFor(() => client.events.some((event) => event.type === "extension_ui_request" && event.method === "setStatus"), "Pi session startup");
  if (expectedWarning) {
    await waitFor(() => client.events.some((event) => event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message.includes(expectedWarning)), "memory model configuration warning", 20_000);
  }
  console.error(`[memory-model-runtime] Pi ${caseDir.endsWith("pi-a") ? "A" : "B"} started`);
  const beforeState = (await client.send("get_state")).data;
  const beforeEntries = (await client.send("get_entries")).data;
  for (const message of commandSequence) {
    console.error(`[memory-model-runtime] Pi command ${message}`);
    await client.send("prompt", { message });
  }
  const afterState = (await client.send("get_state")).data;
  const afterEntries = (await client.send("get_entries")).data;
  console.error("[memory-model-runtime] closing Pi command session");
  await client.close();
  writeJson(join(caseDir, "rpc-events.json"), client.events);
  const observations = existsSync(observationLog)
    ? readFileSync(observationLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { beforeState, beforeEntries, afterState, afterEntries, events: client.events, observations };
}

async function validateConfiguration() {
  const capabilities = await describeMemoryModelCapabilities(root);
  const credentialInvocations = [];
  const isolatedCredentialVariable = "PCR_VALIDATION_ISOLATED_OPENROUTER_KEY";
  const inheritedIsolatedCredential = process.env[isolatedCredentialVariable];
  const isolatedCredential = createIsolatedPiProviderCredential("openrouter", isolatedCredentialVariable, {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: "/validation/pi-agent" },
    run: (command, args, options) => {
      credentialInvocations.push({ command, args, options });
      return { status: 0, stdout: "validation-pi-openrouter-key\n", stderr: "" };
    },
  });
  const unavailableCredentialError = await expectFailure(() => createIsolatedPiProviderCredential(
    "openrouter",
    isolatedCredentialVariable,
    { run: () => ({ status: 1, stdout: "", stderr: "unavailable-secret-output" }) },
  ));
  const piCredentialInjectedIntoIsolatedEnvironment = isolatedCredential.reference === `\${${isolatedCredentialVariable}}`
    && isolatedCredential.environment[isolatedCredentialVariable] === "validation-pi-openrouter-key"
    && process.env[isolatedCredentialVariable] === inheritedIsolatedCredential
    && credentialInvocations.length === 1
    && credentialInvocations[0].command === "pi"
    && credentialInvocations[0].args.join(" ") === "auth print-api-key --provider openrouter"
    && credentialInvocations[0].options.env.PI_CODING_AGENT_DIR === "/validation/pi-agent"
    && unavailableCredentialError?.includes("authenticate with /login openrouter")
    && !unavailableCredentialError.includes("unavailable-secret-output");
  const providers = capabilities.providers.map((item) => item.name);
  const reviewedConfigurationAdapterSurface = JSON.stringify(providers) === JSON.stringify(expectedProviders);
  const schemaObserved = capabilities.openVikingVersion === expectedOpenVikingVersion
    && capabilities.vlmSchemaSha256 === adapterContract.vlmSchemaSha256
    && typeof capabilities.adapterContractSha256 === "string"
    && Object.keys(capabilities.settingFields).sort().join(",") === [...adapterContract.settingFields].sort().join(",");
  const litellmCatalogObserved = capabilities.litellmCatalogUrl === adapterContract.litellmCatalogUrl;
  const adapterProbe = spawnSync(
    pythonCommand,
    [join(root, "scripts/validate-openviking-vlm-adapters.py")],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  const adapterResult = adapterProbe.status === 0 ? JSON.parse(adapterProbe.stdout) : undefined;
  const adapterRoutes = adapterResult?.litellmRoutes;
  const openRouterRequest = adapterResult?.litellmOpenRouterRequest;
  const adapterProtocolsCovered = adapterResult?.passed === true
    && Object.keys(adapterResult.providers).join(",") === expectedProviders.join(",")
    && adapterResult.messages === true
    && adapterResult.tools === true
    && adapterResult.toolChoice === true
    && adapterResult.functionCalls === true
    && adapterRoutes?.detectedPrefix === true
    && adapterRoutes.genericCredentialMapped === true
    && adapterRoutes.sourceEnvironmentDelegated === true
    && adapterRoutes.keywordConflictObserved === true
    && adapterRoutes.zaiAliasPreserved === true
    && adapterRoutes.nativeRoutePreserved === true
    && adapterRoutes.customOpenAICompatible === true
    && adapterRoutes.ollamaDefaults === true
    && openRouterRequest?.model === "openrouter/validation/model"
    && openRouterRequest.apiKeyForwarded === true
    && openRouterRequest.reasoningForwarded === false
    && openRouterRequest.temperatureForwarded === true
    && openRouterRequest.temperature === 0
    && openRouterRequest.timeoutForwarded === true
    && adapterResult.codexRequest?.reasoningForwarded === false
    && adapterResult.codexRequest?.temperatureForwarded === false
    && adapterResult.codexRequest?.stream === true
    && adapterResult.codexRequest?.store === false;
  const caseDir = join(artifactRoot, "configuration");
  const basePath = join(caseDir, "base.json");
  writeJson(basePath, baseConfig(await freePort(), join(caseDir, "data")));
  const env = {
    ...process.env,
    PCR_OPENVIKING_BASE_CONFIG: basePath,
    [VALIDATION_API_KEY_ENV]: VALIDATION_API_KEY,
  };
  const unreviewedProviderRejected = Boolean(await expectFailure(() => compileOpenVikingConfig(
    root,
    { provider: "unreviewed-provider", model: "validation", api_key: VALIDATION_API_KEY_REFERENCE },
    env,
  )));
  const compiled = [];
  for (const descriptor of capabilities.providers) {
    const setting = { provider: descriptor.name, model: descriptor.name === "litellm" ? "bedrock/validation" : "validation-model" };
    if (descriptor.credential === "api-key") setting.api_key = VALIDATION_API_KEY_REFERENCE;
    for (const field of descriptor.required) setting[field] = field === "api_base" ? "https://example.invalid/v1" : "validation";
    compiled.push(await compileOpenVikingConfig(root, setting, env));
  }
  const generatedConfigParsed = compiled.length === expectedProviders.length
    && compiled.every((item) => item.config.vlm.provider === item.provider && item.config.vlm.model === item.model);
  const runtimeProfileApplied = compiled.every((item) => {
    const vlm = item.config.vlm;
    return item.profile.provider === item.provider
      && item.profile.model === item.model
      && vlm.thinking === item.profile.thinking
      && vlm.temperature === item.profile.temperature
      && vlm.stream === item.profile.stream
      && vlm.max_tokens === item.profile.maxOutputTokens
      && vlm.timeout === item.profile.requestTimeoutMs / 1_000
      && vlm.max_retries === item.profile.maxRetries
      && vlm.max_concurrent === item.profile.maxConcurrency
      && vlm.backup === undefined
      && vlm.credentials === undefined;
  });
  const deterministicSetting = { provider: "volcengine", model: "validation-model", api_key: VALIDATION_API_KEY_REFERENCE };
  const deterministicFingerprint = compiled[0].configFingerprint
    === (await compileOpenVikingConfig(root, deterministicSetting, env)).configFingerprint;
  const rotatedCredential = await compileOpenVikingConfig(root, deterministicSetting, {
    ...env,
    [VALIDATION_API_KEY_ENV]: SECOND_VALIDATION_API_KEY,
  });
  const credentialRotationChangesConfigFingerprint = compiled[0].settingsFingerprint === rotatedCredential.settingsFingerprint
    && compiled[0].configFingerprint !== rotatedCredential.configFingerprint
    && JSON.stringify(compiled[0].config) === JSON.stringify(rotatedCredential.config)
    && !JSON.stringify([compiled[0], rotatedCredential]).includes(VALIDATION_API_KEY)
    && !JSON.stringify([compiled[0], rotatedCredential]).includes(SECOND_VALIDATION_API_KEY);
  const missingCredentialRejected = Boolean(await expectFailure(() => compileOpenVikingConfig(
    root,
    { provider: "openai", model: "validation" },
    env,
  )));
  const azureFieldRejected = Boolean(await expectFailure(() => compileOpenVikingConfig(
    root,
    { provider: "azure", model: "validation", api_key: VALIDATION_API_KEY_REFERENCE },
    env,
  )));
  const openRouterSetting = { provider: "litellm", model: "openrouter/validation/model" };
  const openRouterApiKeyRequired = Boolean(await expectFailure(() => compileOpenVikingConfig(root, openRouterSetting, env)));
  const directApiKey = await compileOpenVikingConfig(
    root,
    { ...openRouterSetting, api_key: "literal-validation-key" },
    env,
  );
  const referencedApiKey = await compileOpenVikingConfig(
    root,
    { ...openRouterSetting, api_key: VALIDATION_API_KEY_REFERENCE },
    env,
  );
  const bracedReferencedApiKey = await compileOpenVikingConfig(
    root,
    { ...openRouterSetting, api_key: VALIDATION_API_KEY_BRACED_REFERENCE },
    env,
  );
  const apiKeyFormsResolved = [directApiKey, referencedApiKey, bracedReferencedApiKey]
    .every((item) => item.config.vlm.api_key === OPENVIKING_MEMORY_API_KEY_REFERENCE)
    && directApiKey[COMPILED_OPENVIKING_CREDENTIAL]?.value === "literal-validation-key"
    && referencedApiKey[COMPILED_OPENVIKING_CREDENTIAL]?.value === VALIDATION_API_KEY
    && bracedReferencedApiKey[COMPILED_OPENVIKING_CREDENTIAL]?.value === VALIDATION_API_KEY
    && directApiKey.credentialEnvironmentVariable === null
    && referencedApiKey.credentialEnvironmentVariable === VALIDATION_API_KEY_ENV
    && bracedReferencedApiKey.credentialEnvironmentVariable === VALIDATION_API_KEY_ENV
    && new Set([
      directApiKey.settingsFingerprint,
      referencedApiKey.settingsFingerprint,
      bracedReferencedApiKey.settingsFingerprint,
    ]).size === 3
    && new Set([
      directApiKey.configFingerprint,
      referencedApiKey.configFingerprint,
      bracedReferencedApiKey.configFingerprint,
    ]).size === 2;
  const credentialsBoundToInternalEnvironment = [directApiKey, referencedApiKey, bracedReferencedApiKey]
    .every((item) => item.config.vlm.api_key === OPENVIKING_MEMORY_API_KEY_REFERENCE
      && Boolean(item[COMPILED_OPENVIKING_CREDENTIAL]?.value));
  const generatedConfigExcludesCredentialValues = [directApiKey, referencedApiKey, bracedReferencedApiKey]
    .every((item) => {
      const serialized = JSON.stringify(item.config);
      return !serialized.includes("literal-validation-key")
        && !serialized.includes(VALIDATION_API_KEY)
        && !serialized.includes(VALIDATION_API_KEY_ENV);
    });
  const missingReferencedCredentialRejected = Boolean(await expectFailure(() => compileOpenVikingConfig(
    root,
    { ...openRouterSetting, api_key: "$MISSING_MEMORY_MODEL_RUNTIME_API_KEY" },
    env,
  )));
  const invalidBridgeBasePath = join(caseDir, "invalid-bridge-base.json");
  writeJson(invalidBridgeBasePath, { embedding: { dense: "invalid" } });
  const credentialDiagnostic = await expectFailure(() => compileOpenVikingConfig(
    root,
    { provider: "openai", model: "validation", api_key: VALIDATION_API_KEY },
    { ...env, PCR_OPENVIKING_BASE_CONFIG: invalidBridgeBasePath },
  ));
  const credentialDiagnosticsRedacted = Boolean(credentialDiagnostic)
    && !credentialDiagnostic.includes(VALIDATION_API_KEY)
    && !credentialDiagnostic.includes(VALIDATION_API_KEY_REFERENCE);
  const codexSetting = { provider: "openai-codex", model: "validation-model" };
  const codexNativeConfig = await compileOpenVikingConfig(root, codexSetting, env);
  const codexNativeCredentialConfigurationPreserved = !Object.hasOwn(codexNativeConfig.config.vlm, "api_key");
  const apiKeysBoundToSettings = compiled.every((item) => item[COMPILED_OPENVIKING_CREDENTIAL]
    ? item.config.vlm.api_key === OPENVIKING_MEMORY_API_KEY_REFERENCE
      && item[COMPILED_OPENVIKING_CREDENTIAL].value === VALIDATION_API_KEY
    : !Object.hasOwn(item.config.vlm, "api_key"));

  const isolatedHome = join(caseDir, "user-home");
  const templateEnv = {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    PCR_MEMORY_MODEL_SETTINGS: undefined,
  };
  const expectedConfigPath = join(isolatedHome, ".pi", "pi-context-memory.jsonc");
  const userConfigPath = memoryModelConfigPath(root, templateEnv) === expectedConfigPath;
  const templatePaths = await Promise.all(Array.from({ length: 8 }, () => ensureMemoryModelConfig(root, templateEnv)));
  const templatePath = templatePaths[0];
  const templateSource = readFileSync(templatePath, "utf8");
  const providerTemplateComplete = capabilities.providers.every((provider, index) => {
    const start = templateSource.indexOf(`  // ${provider.name}:`);
    const nextProvider = capabilities.providers[index + 1];
    const end = nextProvider ? templateSource.indexOf(`  // ${nextProvider.name}:`, start + 1) : templateSource.length;
    if (start < 0 || end < 0) return false;
    const section = templateSource.slice(start, end);
    return section.includes(`\"provider\": \"${provider.name}\"`)
      && section.includes(`\"model\": \"${provider.name === "azure" ? "<deployment-name>" : provider.name === "litellm" ? "<litellm-provider>/<model-id>" : "<model-id>"}\"`)
      && [...new Set([...provider.required, ...provider.optional])]
        .filter((field) => field !== "provider" && field !== "model")
        .every((field) => section.split("\n").some((line) => line.includes(`\"${field}\":`)
          && line.includes(`// ${provider.required.includes(field) ? "必填" : "可选"}`)))
      && section.includes('"api_key": "$')
      && section.includes("也可直接填写 key");
  });
  const litellmSection = templateSource.slice(
    templateSource.indexOf("  // litellm:"),
    templateSource.indexOf("  // openai-codex:"),
  );
  const litellmCatalogDocumented = litellmCatalogObserved
    && litellmSection.includes("<litellm-provider>/<model-id>")
    && litellmSection.includes(capabilities.litellmCatalogUrl)
    && litellmSection.includes("bedrock/<model-id>")
    && litellmSection.includes("sagemaker/<endpoint-name>")
    && litellmSection.includes("vertex_ai/<model-id>")
    && litellmSection.includes("openai/<model-id>")
    && litellmSection.includes("api_base")
    && !litellmSection.includes("关键词")
    && !litellmSection.includes("内置识别");
  const templateSetting = await readMemoryModelSetting(root, templateEnv);
  const commentedTemplateCreated = templateSetting === undefined
    && (statSync(templatePath).mode & 0o777) === 0o600
    && providerTemplateComplete
    && (statSync(dirname(templatePath)).mode & 0o077) === 0
    && templateSource.includes('"memoryModel": null,')
    && templatePaths.every((path) => path === expectedConfigPath)
    && readdirSync(dirname(templatePath)).every((name) => !name.endsWith(".pending"))
    && templateSource.includes("$SOURCE_API_KEY")
    && templateSource.includes("可直接填写 key")
    && !templateSource.includes(VALIDATION_API_KEY);

  const jsoncPath = join(caseDir, "configured.jsonc");
  const jsoncEnv = { ...env, PCR_MEMORY_MODEL_SETTINGS: jsoncPath };
  const jsoncSource = `{
  // The URL contains // inside a JSON string.
  "memoryModel": {
    "provider": "openai",
    "model": "configured-model",
    "api_key": "literal-config-key",
    "api_base": "https://example.invalid/v1/",
  },
}\n`;
  writeFileSync(jsoncPath, jsoncSource, { encoding: "utf8", mode: 0o644 });
  const parsedSetting = await readMemoryModelSetting(root, jsoncEnv);
  const jsoncConfigurationParsed = parsedSetting?.model === "configured-model"
    && parsedSetting.api_key === "literal-config-key"
    && parsedSetting.api_base === "https://example.invalid/v1"
    && (statSync(jsoncPath).mode & 0o777) === 0o600;
  const emptyPath = join(caseDir, "empty.jsonc");
  const emptyEnv = { ...env, PCR_MEMORY_MODEL_SETTINGS: emptyPath };
  writeFileSync(emptyPath, "// No memory model is enabled yet.\n", { encoding: "utf8", mode: 0o600 });
  const emptyConfigurationAccepted = await readMemoryModelSetting(root, emptyEnv) === undefined;

  const invalidPath = join(caseDir, "invalid.jsonc");
  const invalidEnv = { ...env, PCR_MEMORY_MODEL_SETTINGS: invalidPath };
  const invalidSource = `{
  "memoryModel": {
    "provider": "openai",
    "model": "syntax-secret-value",,
  }
}\n`;
  writeFileSync(invalidPath, invalidSource, { encoding: "utf8", mode: 0o600 });
  const syntaxError = await expectFailure(() => readMemoryModelSetting(root, invalidEnv));
  await ensureMemoryModelConfig(root, invalidEnv);
  const existingConfigPreserved = readFileSync(invalidPath, "utf8") === invalidSource;
  const invalidFingerprint = await memoryModelConfigContentFingerprint(root, invalidEnv);
  writeFileSync(invalidPath, `${invalidSource} `, { encoding: "utf8", mode: 0o600 });
  const changedInvalidFingerprint = await memoryModelConfigContentFingerprint(root, invalidEnv);
  const configurationDiagnosticContentHashed = /^[a-f0-9]{64}$/.test(invalidFingerprint ?? "")
    && /^[a-f0-9]{64}$/.test(changedInvalidFingerprint ?? "")
    && invalidFingerprint !== changedInvalidFingerprint;

  const symlinkTarget = join(caseDir, "symlink-target.jsonc");
  const symlinkPath = join(caseDir, "existing-symlink.jsonc");
  const symlinkSource = '{ "memoryModel": null }\n';
  writeFileSync(symlinkTarget, symlinkSource, { encoding: "utf8", mode: 0o600 });
  symlinkSync(symlinkTarget, symlinkPath);
  const symlinkEnv = { ...env, PCR_MEMORY_MODEL_SETTINGS: symlinkPath };
  await ensureMemoryModelConfig(root, symlinkEnv);
  const danglingPath = join(caseDir, "dangling-symlink.jsonc");
  symlinkSync(join(caseDir, "absent-target.jsonc"), danglingPath);
  await ensureMemoryModelConfig(root, { ...env, PCR_MEMORY_MODEL_SETTINGS: danglingPath });
  const existingSymlinksPreserved = lstatSync(symlinkPath).isSymbolicLink()
    && readFileSync(symlinkTarget, "utf8") === symlinkSource
    && lstatSync(danglingPath).isSymbolicLink()
    && !existsSync(join(caseDir, "absent-target.jsonc"));
  const semanticPath = join(caseDir, "semantic-error.jsonc");
  const semanticEnv = { ...env, PCR_MEMORY_MODEL_SETTINGS: semanticPath };
  writeJson(semanticPath, { memoryModel: { provider: "openai", model: "validation", api_secret: "must-not-be-stored" } });
  const semanticError = await expectFailure(() => readMemoryModelSetting(root, semanticEnv));
  const invalidConfigDiagnosed = Boolean(
    syntaxError?.includes(invalidPath)
    && /:\d+:\d+:/.test(syntaxError)
    && !syntaxError.includes("syntax-secret-value")
    && semanticError?.includes("api_secret")
    && semanticError.includes(semanticPath)
    && !semanticError.includes("must-not-be-stored"),
  );
  const unknownFieldRejected = Boolean(semanticError);
  return {
    checks: {
      adapterProtocolsCovered,
      reviewedConfigurationAdapterSurface,
      unreviewedProviderRejected,
      schemaObserved,
      litellmCatalogObserved,
      generatedConfigParsed,
      runtimeProfileApplied,
      deterministicFingerprint,
      credentialRotationChangesConfigFingerprint,
      credentialsBoundToInternalEnvironment,
      generatedConfigExcludesCredentialValues,
      apiKeyFormsResolved,
      apiKeysBoundToSettings,
      codexNativeCredentialConfigurationPreserved,
      credentialDiagnosticsRedacted,
      piCredentialInjectedIntoIsolatedEnvironment,
      missingReferencedCredentialRejected,
      openRouterApiKeyRequired,
      unknownFieldRejected,
      missingCredentialRejected,
      azureFieldRejected,
      userConfigPath,
      commentedTemplateCreated,
      litellmCatalogDocumented,
      jsoncConfigurationParsed,
      emptyConfigurationAccepted,
      invalidConfigDiagnosed,
      existingConfigPreserved,
      existingSymlinksPreserved,
      configurationDiagnosticContentHashed,
    },
    capabilities,
  };
}

async function validateLauncherAndCommands() {
  const caseDir = join(artifactRoot, "launcher");
  mkdirSync(caseDir, { recursive: true });
  const fakeServer = join(caseDir, "fake-openviking.mjs");
  createFakeServer(fakeServer);
  const missingCredentialDir = join(caseDir, "openrouter-missing-credential");
  mkdirSync(missingCredentialDir, { recursive: true });
  const missingCredentialBase = join(missingCredentialDir, "base.json");
  writeJson(missingCredentialBase, baseConfig(await freePort(), join(missingCredentialDir, "data")));
  const missingCredentialEnv = validationEnvironment(missingCredentialDir, missingCredentialBase, fakeServer);
  await writeMemoryModelConfig(missingCredentialEnv.PCR_MEMORY_MODEL_SETTINGS, {
    provider: validationSuite.models.memoryProvider,
    model: validationSuite.models.memoryRoute,
  }, false);
  const missingCredentialLauncher = startLauncher(missingCredentialEnv);
  let missingCredentialState;
  try {
    const missingCredentialOutput = [];
    missingCredentialLauncher.stderr.on("data", (chunk) => missingCredentialOutput.push(Buffer.from(chunk)));
    missingCredentialLauncher.stdout.on("data", (chunk) => missingCredentialOutput.push(Buffer.from(chunk)));
    missingCredentialState = await waitFor(async () => {
      const state = await readRuntimeState(root, missingCredentialEnv);
      if (state?.phase === "failed") {
        throw new Error(`${state.error ?? "missing-credential launcher failed"}\n${Buffer.concat(missingCredentialOutput).toString("utf8")}`);
      }
      return state?.ready === true && state.configurationError ? state : undefined;
    }, "OpenRouter credential diagnostic");
  } finally {
    await stopLauncher(missingCredentialLauncher).catch(() => undefined);
  }
  const openRouterLauncherCredentialRequired = missingCredentialState?.ready === true
    && missingCredentialState.activeProvider === undefined
    && missingCredentialState.configurationError.includes("api_key is required for OpenViking provider litellm")
    && !missingCredentialState.configurationError.includes(VALIDATION_API_KEY);
  const port = await freePort();
  const basePath = join(caseDir, "base.json");
  writeJson(basePath, baseConfig(port, join(caseDir, "data")));
  const env = validationEnvironment(caseDir, basePath, fakeServer);
  await writeMemoryModelConfig(
    env.PCR_MEMORY_MODEL_SETTINGS,
    supportedMemorySetting({ apiKey: VALIDATION_API_KEY_REFERENCE }),
  );
  const launcher = startLauncher(env);
  const launcherOutput = [];
  launcher.stdout.on("data", (chunk) => launcherOutput.push(Buffer.from(chunk)));
  launcher.stderr.on("data", (chunk) => launcherOutput.push(Buffer.from(chunk)));
  let targetOccupant;
  try {
    const initial = await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.ready ? state : undefined;
    }, "initial OpenViking readiness");
    const initialCapabilityBinding = {
      launchId: initial.launchId,
      childPid: initial.childPid,
      settingsFingerprint: initial.activeSettingsFingerprint,
      configFingerprint: initial.activeConfigFingerprint,
      profile: initial.activeProfile,
      profileFingerprint: initial.activeProfileFingerprint,
    };
    const capabilityGatePublished = initial.serviceReady === true
      && initial.requestReady === true
      && memoryCapabilityMatches(initial.memoryCapability, initialCapabilityBinding);
    const capabilityProofDefinesGeneration = memoryRuntimeGenerationIdentity(initial.memoryCapability)
      !== memoryRuntimeGenerationIdentity({ ...initial.memoryCapability, proofId: `${initial.memoryCapability.proofId}-changed` });
    const inconsistentCapabilityUsageRejected = !memoryCapabilityMatches({
      ...initial.memoryCapability,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 14 },
    }, initialCapabilityBinding);
    const generatedRuntimeSource = readFileSync(env.PCR_OPENVIKING_GENERATED_CONFIG, "utf8");
    const initialLauncherInfo = await readLauncherInfo(root, env);
    const childEnvironment = JSON.parse(readFileSync(env.PCR_OPENVIKING_CHILD_ENV_REPORT, "utf8"));
    const childCredentialEnvironmentIsolated = !childEnvironment.credentialEnvironmentVariablesPresent?.includes(VALIDATION_API_KEY_ENV)
      && childEnvironment.internalCredentialPresent === true
      && childEnvironment.internalCredentialSha256 === createHash("sha256").update(VALIDATION_API_KEY).digest("hex")
      && childEnvironment.ambientOpenRouterCredentialPresent === false
      && childEnvironment.unrelatedProviderCredentialPresent === false;
    const configurationFilesRestricted = (statSync(env.PCR_MEMORY_MODEL_SETTINGS).mode & 0o777) === 0o600
      && (statSync(env.PCR_OPENVIKING_GENERATED_CONFIG).mode & 0o777) === 0o600;
    const runtimeCredentialValuesNotPersisted = generatedRuntimeSource.includes(OPENVIKING_MEMORY_API_KEY_REFERENCE)
      && !generatedRuntimeSource.includes(VALIDATION_API_KEY)
      && !generatedRuntimeSource.includes(VALIDATION_API_KEY_ENV)
      && !JSON.stringify(initial).includes(VALIDATION_API_KEY)
      && !JSON.stringify(initialLauncherInfo).includes(VALIDATION_API_KEY);
    const firstChildPid = initial.childPid;
    await atomicWriteJson(env.PCR_OPENVIKING_STATE, { ...initial, childPid: 999_999_999 });
    const suppressedDeadChild = await readRuntimeState(root, env);
    const deadChildReadySuppressed = suppressedDeadChild?.phase === "failed"
      && suppressedDeadChild.ready === false
      && suppressedDeadChild.activeModel === undefined;
    await atomicWriteJson(env.PCR_OPENVIKING_STATE, initial);

    const competingLauncher = startLauncher(env);
    competingLauncher.stdout.resume();
    competingLauncher.stderr.resume();
    const competingExit = await waitForExit(competingLauncher);
    const concurrentLauncherRejected = competingExit.code !== 0
      && processAlive(launcher.pid)
      && processAlive(firstChildPid);

    const occupiedTargetPort = await freePort();
    targetOccupant = createServer((_, response) => response.end("unowned-target"));
    await new Promise((resolveListen, rejectListen) => {
      targetOccupant.once("error", rejectListen);
      targetOccupant.listen(occupiedTargetPort, "127.0.0.1", resolveListen);
    });
    writeJson(basePath, baseConfig(occupiedTargetPort, join(caseDir, "target-data")));
    const targetPortError = await expectFailure(() => requestOpenVikingRestart(root, env));
    const afterTargetPortError = await readRuntimeState(root, env);
    const targetPortPreflightPreservesInstance = Boolean(targetPortError)
      && afterTargetPortError?.ready === true
      && afterTargetPortError.childPid === firstChildPid
      && processAlive(firstChildPid)
      && targetOccupant.listening;
    writeJson(basePath, baseConfig(port, join(caseDir, "data")));
    await new Promise((resolveClose) => targetOccupant.close(resolveClose));
    targetOccupant = undefined;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "unknown", model: "invalid" });
    const preflightError = await expectFailure(() => requestOpenVikingRestart(root, env));
    const afterPreflight = await readRuntimeState(root, env);
    const preflightPreservesInstance = Boolean(preflightError)
      && afterPreflight?.ready === true
      && afterPreflight.childPid === firstChildPid
      && processAlive(firstChildPid)
      && preflightError.includes(env.PCR_MEMORY_MODEL_SETTINGS)
      && afterPreflight.configurationError === undefined;

    const invalidPiCase = await runPiCommandCase(
      join(caseDir, "pi-invalid-config"),
      env,
      [],
      "Invalid memory model configuration",
    );
    const automaticWarnings = invalidPiCase.events.filter((event) => event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message.includes("Invalid memory model configuration"));
    const automaticDiagnostic = invalidPiCase.observations.find((row) => row.type === "memory_model_config_error");
    const invalidConfigStatuses = invalidPiCase.events.filter((event) => event.type === "extension_ui_request"
      && event.method === "setStatus").map((event) => event.statusText);
    const automaticConfigErrorReported = automaticWarnings.length === 1
      && automaticWarnings[0].message.includes("The running OpenViking instance remains available until restart.")
      && /^[a-f0-9]{64}$/.test(automaticDiagnostic?.contentFingerprint ?? "")
      && !invalidPiCase.observations.some((row) => row.type === "before_provider_request");
    const invalidDesiredConfigPreservesRunningInstance = afterPreflight?.ready === true
      && invalidConfigStatuses.includes("增强记忆 · 初始化中")
      && invalidConfigStatuses.every((status) => status === undefined || status === "增强记忆 · 初始化中");
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "second" }));
    const second = await requestOpenVikingRestart(root, env);
    const orderedRestart = second.ready === true
      && second.childPid !== firstChildPid
      && second.configurationError === undefined
      && !processAlive(firstChildPid);

    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ scenario: "capability-fail" }),
    );
    const capabilityFailure = await expectFailure(() => requestOpenVikingRestart(root, env));
    const capabilityFailureState = await readRuntimeState(root, env);
    const capabilityFailureBlocks = Boolean(capabilityFailure?.includes("capability task failed"))
      && capabilityFailureState?.serviceReady === true
      && capabilityFailureState.requestReady === false
      && capabilityFailureState.memoryCapability === undefined
      && capabilityFailureState.phase === "failed";

    const echoedCredential = "validation-scenario:capability-secret-error";
    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ scenario: "capability-secret-error" }),
    );
    const credentialEchoFailure = await expectFailure(() => requestOpenVikingRestart(root, env));
    const credentialEchoState = await readRuntimeState(root, env);
    const capabilityErrorsRedacted = Boolean(credentialEchoFailure?.includes("<redacted>"))
      && !credentialEchoFailure.includes(echoedCredential)
      && !JSON.stringify(credentialEchoState).includes(echoedCredential);

    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ scenario: "capability-fail-cleanup-fail" }),
    );
    const combinedProbeFailure = await expectFailure(() => requestOpenVikingRestart(root, env));
    const combinedProbeFailureState = await readRuntimeState(root, env);
    const failedProbeCleanupReported = Boolean(combinedProbeFailure?.includes("capability task failed")
      && combinedProbeFailure.includes("cleanup also failed")
      && combinedProbeFailure.includes("injected cleanup failure"))
      && combinedProbeFailureState?.requestReady === false
      && combinedProbeFailureState.memoryCapability === undefined;

    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ scenario: "empty-overview" }),
    );
    const emptyOverviewFailure = await expectFailure(() => requestOpenVikingRestart(root, env));
    const emptyOverviewState = await readRuntimeState(root, env);
    const emptyWorkingMemoryOverviewRejected = emptyOverviewFailure?.includes("marker-bearing Working Memory overview") === true
      && emptyOverviewState?.serviceReady === true
      && emptyOverviewState.requestReady === false
      && emptyOverviewState.memoryCapability === undefined;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "second" }));
    const capabilityRecoveryState = await requestOpenVikingRestart(root, env);
    const explicitCapabilityRecovery = capabilityRecoveryState.requestReady === true
      && capabilityRecoveryState.memoryCapability?.childPid === capabilityRecoveryState.childPid;

    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ apiKey: VALIDATION_API_KEY_REFERENCE }),
    );
    const credentialBoundaryState = await requestOpenVikingRestart(root, env);
    const piWithoutCredentialEnv = { ...env };
    delete piWithoutCredentialEnv[VALIDATION_API_KEY_ENV];
    const credentialBoundaryPiCase = await runPiCommandCase(
      join(caseDir, "pi-credential-boundary"),
      piWithoutCredentialEnv,
      ["/memory-model"],
    );
    const credentialBoundaryStatuses = credentialBoundaryPiCase.events.filter((event) => event.type === "extension_ui_request"
      && event.method === "setStatus").map((event) => event.statusText);
    const splitCredentialRuntimeAvailable = credentialBoundaryState.ready === true
      && credentialBoundaryState.activeProvider === validationSuite.models.memoryProvider
      && credentialBoundaryStatuses.includes("增强记忆 · 初始化中")
      && !credentialBoundaryStatuses.includes("增强记忆 · 故障")
      && credentialBoundaryPiCase.events.some((event) => event.type === "extension_ui_request"
        && event.method === "notify"
        && event.message.includes("Configuration: applied"));

    const wrongInfo = await readLauncherInfo(root, env);
    const operationDeadlinePublished = wrongInfo.operationTimeoutMs === OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS
      + (4 * Number(env.PCR_OPENVIKING_STOP_TIMEOUT_MS))
      + Number(env.PCR_OPENVIKING_READINESS_TIMEOUT_MS)
      + MEMORY_RUNTIME_REQUEST_TIMEOUT_MS
      + 5_000;
    const wrongResponse = await fetch(`${wrongInfo.controlUrl}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchId: "wrong-launch" }),
    });
    const wrongLaunchRejected = wrongResponse.status === 403 && second.ready;
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "slow-ready" }));
    const interruptedRequest = httpRequest(`${wrongInfo.controlUrl}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    interruptedRequest.once("error", () => undefined);
    interruptedRequest.end(JSON.stringify({ launchId: wrongInfo.launchId, operationId: "interrupted-operation" }));
    await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.phase === "restarting" && state.operationId === "interrupted-operation" ? state : undefined;
    }, "accepted interrupted restart");
    interruptedRequest.destroy();
    const afterInterruptedControl = await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.ready && state.operationId === "interrupted-operation" ? state : undefined;
    }, "interrupted restart completion");
    const interruptedControlOperationCompletes = afterInterruptedControl.childPid !== second.childPid
      && !processAlive(second.childPid);

    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ apiKey: VALIDATION_API_KEY }),
    );
    const commandConfigBefore = readFileSync(env.PCR_MEMORY_MODEL_SETTINGS, "utf8");
    console.error("[memory-model-runtime] Pi command session A");
    const piCase = await runPiCommandCase(join(caseDir, "pi-a"), env, [
      "/memory-model",
      "/restart-viking",
    ]);
    console.error("[memory-model-runtime] Pi command session B");
    const secondPiCase = await runPiCommandCase(join(caseDir, "pi-b"), env, ["/memory-model"]);
    console.error("[memory-model-runtime] Pi command sessions complete");
    const configCommandReadOnly = readFileSync(env.PCR_MEMORY_MODEL_SETTINGS, "utf8") === commandConfigBefore;
    const commandNoProviderRequests = !piCase.observations.some((row) => row.type === "before_provider_request")
      && !secondPiCase.observations.some((row) => row.type === "before_provider_request");
    const taskModelUnchanged = piCase.beforeState.model.provider === piCase.afterState.model.provider
      && piCase.beforeState.model.id === piCase.afterState.model.id;
    const branchUnchanged = JSON.stringify(piCase.beforeEntries) === JSON.stringify(piCase.afterEntries);
    const piSessionCredentialsExcluded = !JSON.stringify({ piCase, secondPiCase }).includes(VALIDATION_API_KEY);
    const sharedUserConfig = secondPiCase.events.some((event) => event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message.includes(`${validationSuite.models.memoryProvider}/${validationSuite.models.memoryRoute}`));
    const configuredAndRunningReportedSeparately = piCase.events.some((event) => event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message.includes(`Configured memory model: ${validationSuite.models.memoryProvider}/${validationSuite.models.memoryRoute}`)
      && event.message.includes(`Running OpenViking model: ${validationSuite.models.memoryProvider}/${validationSuite.models.memoryRoute}`)
      && event.message.includes("Extension authorization: 初始化中"));
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, null);
    const nullPiCase = await runPiCommandCase(join(caseDir, "pi-null-config"), env, [
      "/memory-model",
      "/restart-viking",
      "/memory-model",
    ]);
    const nullNotifications = nullPiCase.events.filter((event) => event.type === "extension_ui_request"
      && event.method === "notify");
    const nullConfigurationStateReported = nullNotifications.some((event) => event.message.includes("Configured memory model: not configured")
      && event.message.includes(`Running OpenViking model: ${validationSuite.models.memoryProvider}/${validationSuite.models.memoryRoute}`)
      && event.message.includes("Configuration: waiting for /restart-viking"))
      && nullNotifications.some((event) => event.message.includes("Configured memory model: not configured")
        && event.message.includes("Running OpenViking model: no VLM loaded")
        && event.message.includes("Configuration: applied"))
      && !nullPiCase.observations.some((row) => row.type === "before_provider_request");
    const statusEvents = [...piCase.events, ...secondPiCase.events, ...nullPiCase.events].filter((event) => event.type === "extension_ui_request"
      && event.method === "setStatus");
    const statusTexts = statusEvents.map((event) => event.statusText);
    const memoryStatusVocabularyCurrent = statusTexts.includes("增强记忆 · 初始化中")
      && statusTexts.includes("增强记忆 · 故障")
      && statusTexts.every((status) => status === undefined
        || status === "增强记忆 · 初始化中"
        || status === "增强记忆"
        || status === "增强记忆 · 故障");

    console.error("[memory-model-runtime] restart failure matrix");
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "slow-ready" }));
    const concurrent = await Promise.allSettled([
      requestOpenVikingRestart(root, env),
      requestOpenVikingRestart(root, env),
    ]);
    const concurrentRestartSerialized = concurrent.filter((item) => item.status === "fulfilled").length === 1
      && concurrent.filter((item) => item.status === "rejected").length === 1;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "ignore-term" }));
    await requestOpenVikingRestart(root, env);
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "never-ready-ignore-term" }));
    const failureStartedAt = Date.now();
    const readinessError = await expectFailure(() => requestOpenVikingRestart(root, env));
    const failureDurationMs = Date.now() - failureStartedAt;
    const operationDeadlineCoversFailureCleanup = Boolean(readinessError)
      && failureDurationMs >= (2 * Number(env.PCR_OPENVIKING_STOP_TIMEOUT_MS)) + Number(env.PCR_OPENVIKING_READINESS_TIMEOUT_MS)
      && failureDurationMs < wrongInfo.operationTimeoutMs;
    const timedOutState = await readRuntimeState(root, env);
    const readinessTimeoutPublished = Boolean(readinessError)
      && timedOutState?.phase === "failed"
      && timedOutState.ready === false
      && timedOutState.childPid === undefined
      && timedOutState.activeModel === undefined
      && timedOutState.targetModel === validationSuite.models.memoryRoute;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "recovered" }));
    const recovered = await requestOpenVikingRestart(root, env);
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, supportedMemorySetting({ scenario: "exit-early" }));
    const exitError = await expectFailure(() => requestOpenVikingRestart(root, env));
    const exitState = await readRuntimeState(root, env);
    const childExitPublished = recovered.ready === true
      && Boolean(exitError)
      && exitState?.phase === "failed"
      && exitState.ready === false;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, null);
    const sourceOnly = await requestOpenVikingRestart(root, env);
    const emptyConfigurationDisablesModel = sourceOnly.ready === true
      && sourceOnly.activeProvider === undefined
      && sourceOnly.activeModel === undefined
      && sourceOnly.configurationError === undefined;
    const sourceOnlyEnvironment = JSON.parse(readFileSync(env.PCR_OPENVIKING_CHILD_ENV_REPORT, "utf8"));
    const removedReferenceRemainsExcluded = sourceOnlyEnvironment.credentialEnvironmentVariablesPresent?.length === 0
      && sourceOnlyEnvironment.internalCredentialPresent === false;
    const sourceOnlyCredentialEnvironmentEmpty = sourceOnlyEnvironment.internalCredentialPresent === false
      && sourceOnlyEnvironment.ambientOpenRouterCredentialPresent === false
      && sourceOnlyEnvironment.unrelatedProviderCredentialPresent === false;
    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ apiKey: SECOND_VALIDATION_API_KEY_REFERENCE }),
    );
    await requestOpenVikingRestart(root, env);
    const rotatedEnvironment = JSON.parse(readFileSync(env.PCR_OPENVIKING_CHILD_ENV_REPORT, "utf8"));
    const rotatedCredentialReferencesExcluded = [VALIDATION_API_KEY_ENV, SECOND_VALIDATION_API_KEY_ENV]
      .every((name) => !rotatedEnvironment.credentialEnvironmentVariablesPresent?.includes(name))
      && rotatedEnvironment.internalCredentialPresent === true
      && rotatedEnvironment.internalCredentialSha256 === createHash("sha256").update(SECOND_VALIDATION_API_KEY).digest("hex");
    await writeMemoryModelConfig(
      env.PCR_MEMORY_MODEL_SETTINGS,
      supportedMemorySetting({ apiKey: DIRECT_VALIDATION_API_KEY }),
    );
    const finalState = await requestOpenVikingRestart(root, env);
    const directEnvironment = JSON.parse(readFileSync(env.PCR_OPENVIKING_CHILD_ENV_REPORT, "utf8"));
    const referencedCredentialsRemainExcludedWithDirectKey = [VALIDATION_API_KEY_ENV, SECOND_VALIDATION_API_KEY_ENV]
      .every((name) => !directEnvironment.credentialEnvironmentVariablesPresent?.includes(name))
      && directEnvironment.internalCredentialPresent === true
      && directEnvironment.internalCredentialSha256 === createHash("sha256").update(DIRECT_VALIDATION_API_KEY).digest("hex");
    const ownedChild = finalState.childPid;
    launcher.kill("SIGTERM");
    launcher.kill("SIGHUP");
    await waitForExit(launcher);
    const launcherLog = Buffer.concat(launcherOutput).toString("utf8");
    const launcherLogsExcludeCredentials = [VALIDATION_API_KEY, SECOND_VALIDATION_API_KEY, DIRECT_VALIDATION_API_KEY]
      .every((credential) => !launcherLog.includes(credential));
    const childCredentialOutputRedacted = launcherLogsExcludeCredentials && launcherLog.includes("<redacted>");
    const stopped = JSON.parse(readFileSync(env.PCR_OPENVIKING_STATE, "utf8"));
    const staleRuntimeSuppressed = await readRuntimeState(root, env) === undefined;
    const signalCleansOwnedChild = !processAlive(ownedChild)
      && !existsSync(env.PCR_OPENVIKING_LAUNCHER_INFO)
      && !existsSync(join(env.PCR_OPENVIKING_RUNTIME_DIR, "launcher.lock"))
      && stopped?.phase === "stopped";
    const missingLauncherError = await expectFailure(() => requestOpenVikingRestart(root, env));
    const missingLauncherReported = missingLauncherError?.includes("Start it with: node scripts/start-openviking.mjs") === true;

    return {
      checks: {
        concurrentLauncherRejected,
        deadChildReadySuppressed,
        capabilityGatePublished,
        capabilityProofDefinesGeneration,
        inconsistentCapabilityUsageRejected,
        targetPortPreflightPreservesInstance,
        preflightPreservesInstance,
        orderedRestart,
        capabilityFailureBlocks,
        capabilityErrorsRedacted,
        failedProbeCleanupReported,
        emptyWorkingMemoryOverviewRejected,
        explicitCapabilityRecovery,
        childCredentialEnvironmentIsolated,
        removedReferenceRemainsExcluded,
        sourceOnlyCredentialEnvironmentEmpty,
        rotatedCredentialReferencesExcluded,
        referencedCredentialsRemainExcludedWithDirectKey,
        configurationFilesRestricted,
        runtimeCredentialValuesNotPersisted,
        launcherLogsExcludeCredentials,
        childCredentialOutputRedacted,
        operationDeadlinePublished,
        operationDeadlineCoversFailureCleanup,
        wrongLaunchRejected,
        interruptedControlOperationCompletes,
        automaticConfigErrorReported,
        invalidDesiredConfigPreservesRunningInstance,
        openRouterLauncherCredentialRequired,
        splitCredentialRuntimeAvailable,
        commandNoProviderRequests,
        taskModelUnchanged,
        branchUnchanged,
        piSessionCredentialsExcluded,
        configCommandReadOnly,
        sharedUserConfig,
        configuredAndRunningReportedSeparately,
        nullConfigurationStateReported,
        memoryStatusVocabularyCurrent,
        concurrentRestartSerialized,
        readinessTimeoutPublished,
        childExitPublished,
        emptyConfigurationDisablesModel,
        signalCleansOwnedChild,
        staleRuntimeSuppressed,
        missingLauncherReported,
      },
    };
  } finally {
    if (targetOccupant?.listening) await new Promise((resolveClose) => targetOccupant.close(resolveClose));
    await stopLauncher(launcher).catch(() => undefined);
  }
}

async function validateOwnershipBoundaries() {
  const caseDir = join(artifactRoot, "ownership");
  mkdirSync(caseDir, { recursive: true });
  const fakeServer = join(caseDir, "fake-openviking.mjs");
  createFakeServer(fakeServer);

  const occupiedPort = await freePort();
  const occupant = createServer((_, response) => response.end("unowned"));
  await new Promise((resolveListen, rejectListen) => {
    occupant.once("error", rejectListen);
    occupant.listen(occupiedPort, "127.0.0.1", resolveListen);
  });
  const occupiedDir = join(caseDir, "occupied");
  const occupiedBase = join(occupiedDir, "base.json");
  writeJson(occupiedBase, baseConfig(occupiedPort, join(occupiedDir, "data")));
  const occupiedEnv = validationEnvironment(occupiedDir, occupiedBase, fakeServer);
  const occupiedLauncher = startLauncher(occupiedEnv);
  let resetServer;
  let coldLauncher;
  try {
    const failed = await waitFor(async () => {
      const state = await readRuntimeState(root, occupiedEnv);
      return state?.phase === "failed" ? state : undefined;
    }, "occupied-port failure");
    const unknownPortPreserved = failed.error.includes("unowned process") && occupant.listening;

    const staleDir = join(caseDir, "stale-owner");
    const staleBase = join(staleDir, "base.json");
    writeJson(staleBase, baseConfig(await freePort(), join(staleDir, "data")));
    const staleEnv = validationEnvironment(staleDir, staleBase, fakeServer);
    await atomicWriteJson(staleEnv.PCR_OPENVIKING_LAUNCHER_INFO, {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId: "not-this-launch",
      launcherPid: process.pid,
      controlUrl: "http://127.0.0.1:1",
    });
    const staleLauncher = startLauncher(staleEnv);
    staleLauncher.stdout.resume();
    staleLauncher.stderr.resume();
    const staleExit = await waitForExit(staleLauncher);
    const launcherOwnershipProtected = staleExit.code !== 0 && processAlive(process.pid);

    const staleLockDir = join(caseDir, "stale-lock");
    const staleLockBase = join(staleLockDir, "base.json");
    writeJson(staleLockBase, baseConfig(await freePort(), join(staleLockDir, "data")));
    const staleLockEnv = validationEnvironment(staleLockDir, staleLockBase, fakeServer);
    const staleLockPath = join(staleLockEnv.PCR_OPENVIKING_RUNTIME_DIR, "launcher.lock");
    await atomicWriteJson(staleLockPath, { schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION, launchId: "dead-launch", launcherPid: 999_999_999 });
    const staleLockLauncher = startLauncher(staleLockEnv);
    staleLockLauncher.stdout.resume();
    staleLockLauncher.stderr.resume();
    const staleLockExit = await waitForExit(staleLockLauncher);
    const staleLifecycleLockRequiresExplicitRecovery = staleLockExit.code !== 0 && existsSync(staleLockPath);

    const coldDir = join(caseDir, "invalid-cold-start");
    const coldBase = join(coldDir, "base.json");
    writeJson(coldBase, baseConfig(await freePort(), join(coldDir, "data")));
    const coldEnv = validationEnvironment(coldDir, coldBase, fakeServer);
    writeFileSync(
      coldEnv.PCR_MEMORY_MODEL_SETTINGS,
      `{ "memoryModel": { "provider": "openai", "model": "cold-start-model", "api_key": "${VALIDATION_API_KEY_REFERENCE}" }\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    coldLauncher = startLauncher(coldEnv);
    coldLauncher.stdout.resume();
    coldLauncher.stderr.resume();
    const coldState = await waitFor(async () => {
      const state = await readRuntimeState(root, coldEnv);
      return state?.ready ? state : undefined;
    }, "invalid cold-start source runtime", 20_000);
    const coldChildEnvironment = JSON.parse(readFileSync(coldEnv.PCR_OPENVIKING_CHILD_ENV_REPORT, "utf8"));
    const invalidColdStartCredentialExcluded = coldChildEnvironment.credentialEnvironmentVariablesPresent?.length === 0
      && coldChildEnvironment.internalCredentialPresent === false
      && coldChildEnvironment.ambientOpenRouterCredentialPresent === false
      && coldChildEnvironment.unrelatedProviderCredentialPresent === false;
    const invalidColdStartKeepsSourceRuntime = coldState.activeModel === undefined
      && coldState.configurationError?.includes("JSONC syntax error")
      && !coldState.configurationError.includes(VALIDATION_API_KEY)
      && coldState.configurationError.includes(coldEnv.PCR_MEMORY_MODEL_SETTINGS)
      && processAlive(coldState.childPid);
    await stopLauncher(coldLauncher);
    coldLauncher = undefined;

    const reconciliationDir = join(caseDir, "client-reconciliation");
    const reconciliationBase = join(reconciliationDir, "base.json");
    writeJson(reconciliationBase, baseConfig(await freePort(), join(reconciliationDir, "data")));
    const reconciliationEnv = validationEnvironment(reconciliationDir, reconciliationBase, fakeServer);
    resetServer = createServer((request) => request.socket.destroy());
    await new Promise((resolveListen, rejectListen) => {
      resetServer.once("error", rejectListen);
      resetServer.listen(0, "127.0.0.1", resolveListen);
    });
    const resetAddress = resetServer.address();
    if (!resetAddress || typeof resetAddress === "string") throw new Error("Reconciliation server did not obtain a port");
    const reconciliationLaunchId = "reconciliation-launch";
    await atomicWriteJson(join(reconciliationEnv.PCR_OPENVIKING_RUNTIME_DIR, "launcher.lock"), {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId: reconciliationLaunchId,
      launcherPid: process.pid,
    });
    await atomicWriteJson(reconciliationEnv.PCR_OPENVIKING_LAUNCHER_INFO, {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId: reconciliationLaunchId,
      launcherPid: process.pid,
      controlUrl: `http://127.0.0.1:${resetAddress.port}`,
      operationTimeoutMs: 100,
    });
    await atomicWriteJson(reconciliationEnv.PCR_OPENVIKING_STATE, {
      schemaVersion: OPENVIKING_RUNTIME_SCHEMA_VERSION,
      launchId: reconciliationLaunchId,
      launcherPid: process.pid,
      childPid: process.pid,
      operationId: "unrelated-operation",
      phase: "ready",
      ready: true,
      activeProvider: "openai",
      activeModel: "unrelated-model",
    });
    const reconciliationError = await expectFailure(() => requestOpenVikingRestart(root, reconciliationEnv));
    const unrelatedReadyNotReconciled = Boolean(reconciliationError);
    await new Promise((resolveClose) => resetServer.close(resolveClose));
    resetServer = undefined;
    return {
      checks: {
        unknownPortPreserved,
        launcherOwnershipProtected,
        staleLifecycleLockRequiresExplicitRecovery,
        invalidColdStartCredentialExcluded,
        invalidColdStartKeepsSourceRuntime,
        unrelatedReadyNotReconciled,
      },
    };
  } finally {
    if (coldLauncher) await stopLauncher(coldLauncher).catch(() => undefined);
    if (resetServer?.listening) await new Promise((resolveClose) => resetServer.close(resolveClose));
    await stopLauncher(occupiedLauncher).catch(() => undefined);
    await new Promise((resolveClose) => occupant.close(resolveClose));
  }
}

function findArtifactFile(directory, name) {
  if (!existsSync(directory)) return undefined;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === name) return path;
    }
  }
  return undefined;
}

async function validateActualManagedCapability() {
  const caseDir = join(artifactRoot, "actual-managed-capability");
  mkdirSync(caseDir, { recursive: true });
  const port = await freePort();
  const workspace = join(caseDir, "openviking-data");
  const basePath = join(caseDir, "base.json");
  const settingsPath = join(caseDir, "memory-model.jsonc");
  const runtimeDir = join(caseDir, "runtime");
  writeJson(basePath, baseConfig(port, workspace));

  const credentialVariable = "PCR_MEMORY_RUNTIME_OPENROUTER_API_KEY";
  const credential = createIsolatedPiProviderCredential(
    validationSuite.models.taskProvider,
    credentialVariable,
    { cwd: root },
  );
  await atomicWriteJson(settingsPath, {
    memoryModel: {
      provider: validationSuite.models.memoryProvider,
      model: validationSuite.models.memoryRoute,
      api_key: credential.reference,
    },
  });
  const realServer = process.platform === "win32"
    ? join(root, ".venv/Scripts/openviking-server.exe")
    : join(root, ".venv/bin/openviking-server");
  const env = {
    ...process.env,
    ...credential.environment,
    PCR_MEMORY_MODEL_SETTINGS: settingsPath,
    PCR_OPENVIKING_BASE_CONFIG: basePath,
    PCR_OPENVIKING_RUNTIME_DIR: runtimeDir,
    PCR_OPENVIKING_SERVER: realServer,
    PCR_OPENVIKING_CHILD_STDIO: "ignore",
  };
  const managedLauncher = startLauncher(env);
  const stdout = [];
  const stderr = [];
  managedLauncher.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  managedLauncher.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let firstState;
  let recoveredState;
  try {
    firstState = await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      if (state?.phase === "failed") throw new Error(state.error ?? "Actual managed OpenViking capability failed");
      return state?.requestReady ? state : undefined;
    }, "actual managed memory capability", MEMORY_RUNTIME_REQUEST_TIMEOUT_MS + 60_000);
    const firstBinding = {
      launchId: firstState.launchId,
      childPid: firstState.childPid,
      settingsFingerprint: firstState.activeSettingsFingerprint,
      configFingerprint: firstState.activeConfigFingerprint,
      profile: firstState.activeProfile,
      profileFingerprint: firstState.activeProfileFingerprint,
    };
    const actualCapabilityPublished = memoryCapabilityMatches(firstState.memoryCapability, firstBinding)
      && firstState.activeProvider === validationSuite.models.memoryProvider
      && firstState.activeModel === validationSuite.models.memoryRoute;
    const generatedConfig = JSON.parse(readFileSync(join(runtimeDir, "openviking.json"), "utf8"));
    const actualProfileApplied = generatedConfig.vlm?.thinking === firstState.activeProfile.thinking
      && generatedConfig.vlm?.temperature === firstState.activeProfile.temperature
      && generatedConfig.vlm?.stream === firstState.activeProfile.stream
      && generatedConfig.vlm?.max_tokens === firstState.activeProfile.maxOutputTokens
      && generatedConfig.vlm?.timeout === firstState.activeProfile.requestTimeoutMs / 1_000
      && generatedConfig.vlm?.max_retries === firstState.activeProfile.maxRetries
      && generatedConfig.vlm?.max_concurrent === firstState.activeProfile.maxConcurrency
      && generatedConfig.vlm?.backup === undefined
      && generatedConfig.vlm?.credentials === undefined;

    const taskFile = findArtifactFile(workspace, `${firstState.memoryCapability.taskId}.json`);
    const task = taskFile ? JSON.parse(readFileSync(taskFile, "utf8")) : undefined;
    const actualTaskUsage = task?.status === "completed"
      && task?.task_type === "session_commit"
      && task?.result?.token_usage?.llm?.prompt_tokens === firstState.memoryCapability.usage.promptTokens
      && task?.result?.token_usage?.llm?.completion_tokens === firstState.memoryCapability.usage.completionTokens
      && task?.result?.token_usage?.llm?.total_tokens === firstState.memoryCapability.usage.totalTokens;
    const probeSessionId = task?.resource_id;
    const sessionResponse = typeof probeSessionId === "string"
      ? await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${encodeURIComponent(probeSessionId)}`)
      : undefined;
    const sessionBody = sessionResponse ? await sessionResponse.json() : undefined;
    const actualProbeSessionCleaned = sessionBody?.status === "error";

    const usageDatabase = join(workspace, "_system/usage_audit/usage_audit.sqlite3");
    const usageResult = spawnSync(pythonCommand, [
      "-c",
      "import json, sqlite3, sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute(\"SELECT source, token_type, provider, model_name, token_count FROM usage_token_hourly WHERE source='vlm'\")]))",
      usageDatabase,
    ], { encoding: "utf8" });
    const usageRows = usageResult.status === 0 ? JSON.parse(usageResult.stdout) : [];
    const actualProviderUsageBound = usageRows.some((row) => row.provider === validationSuite.models.memoryProvider
      && row.model_name === validationSuite.models.memoryRoute
      && row.token_type === "input"
      && row.token_count > 0)
      && usageRows.some((row) => row.provider === validationSuite.models.memoryProvider
        && row.model_name === validationSuite.models.memoryRoute
        && row.token_type === "output"
        && row.token_count > 0)
      && usageRows.every((row) => row.provider === validationSuite.models.memoryProvider
        && row.model_name === validationSuite.models.memoryRoute);

    const firstChildPid = firstState.childPid;
    process.kill(firstChildPid, "SIGTERM");
    const interruptedState = await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.phase === "failed" && !state.requestReady ? state : undefined;
    }, "actual capability revocation after process exit", 30_000);
    const actualProcessExitRevokesCapability = interruptedState.serviceReady === false
      && interruptedState.memoryCapability === undefined
      && !processAlive(firstChildPid);

    recoveredState = await requestOpenVikingRestart(root, env);
    const recoveredBinding = {
      launchId: recoveredState.launchId,
      childPid: recoveredState.childPid,
      settingsFingerprint: recoveredState.activeSettingsFingerprint,
      configFingerprint: recoveredState.activeConfigFingerprint,
      profile: recoveredState.activeProfile,
      profileFingerprint: recoveredState.activeProfileFingerprint,
    };
    const actualExplicitGenerationRecovery = recoveredState.childPid !== firstChildPid
      && recoveredState.memoryCapability?.proofId !== firstState.memoryCapability.proofId
      && memoryCapabilityMatches(recoveredState.memoryCapability, recoveredBinding);

    const checks = {
      actualCapabilityPublished,
      actualProfileApplied,
      actualTaskUsage,
      actualProbeSessionCleaned,
      actualProviderUsageBound,
      actualProcessExitRevokesCapability,
      actualExplicitGenerationRecovery,
    };
    const artifact = {
      models: {
        provider: validationSuite.models.memoryProvider,
        model: validationSuite.models.memoryRoute,
        api: firstState.activeProfile.api,
      },
      profileFingerprint: firstState.activeProfileFingerprint,
      first: {
        launchId: firstState.launchId,
        childPid: firstState.childPid,
        proofId: firstState.memoryCapability.proofId,
        taskId: firstState.memoryCapability.taskId,
        usage: firstState.memoryCapability.usage,
        assemblyHash: firstState.memoryCapability.assemblyHash,
      },
      recovered: {
        launchId: recoveredState.launchId,
        childPid: recoveredState.childPid,
        proofId: recoveredState.memoryCapability.proofId,
        taskId: recoveredState.memoryCapability.taskId,
        usage: recoveredState.memoryCapability.usage,
        assemblyHash: recoveredState.memoryCapability.assemblyHash,
      },
      usageRows,
      checks,
    };
    writeJson(join(caseDir, "actual-runtime.json"), artifact);
    return { checks, artifact };
  } finally {
    await stopLauncher(managedLauncher).catch(() => undefined);
    const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
    writeFileSync(join(caseDir, "launcher.log"), output.replaceAll(credential.environment[credentialVariable], "<redacted>"), { mode: 0o600 });
  }
}

const startedAt = new Date().toISOString();
console.error("[memory-model-runtime] configuration");
const configuration = await validateConfiguration();
console.error("[memory-model-runtime] launcher and Pi commands");
const launcher = await validateLauncherAndCommands();
console.error("[memory-model-runtime] ownership boundaries");
const ownership = await validateOwnershipBoundaries();
console.error("[memory-model-runtime] actual managed capability");
const actual = await validateActualManagedCapability();
const checks = { ...configuration.checks, ...launcher.checks, ...ownership.checks, ...actual.checks };
const passed = Object.values(checks).every(Boolean);
const completedAt = new Date().toISOString();
const rawEvidence = {
  schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
  generatedBy: "scripts/validate-memory-model-runtime.mjs",
  scope: "managed-provider-runtime",
  runId,
  startedAt,
  completedAt,
  piVersion,
  nodeVersion: process.versions.node,
  platform: process.platform,
  openVikingVersion: configuration.capabilities.openVikingVersion,
  vlmSchemaSha256: configuration.capabilities.vlmSchemaSha256,
  adapterContractSha256: configuration.capabilities.adapterContractSha256,
  implementation,
  actual: actual.artifact,
  passed,
  checks,
  limitations: [
    "The controlled process double covers deterministic protocol, ownership, failure, and recovery branches; the managed-provider arm proves the production probe against the suite-selected real memory route.",
    "Checkpoint refresh remains outside this capability-gate delivery.",
    "General task quality and complete API-cost attribution remain later product stages.",
  ],
};
assertImplementationEvidenceUnchanged(root, "memory-model-runtime", implementation);
replaceJson(evidencePath, {
  schemaVersion: rawEvidence.schemaVersion,
  generatedBy: rawEvidence.generatedBy,
  scope: rawEvidence.scope,
  runId,
  recordedAt: completedAt,
  piVersion,
  nodeVersion: rawEvidence.nodeVersion,
  platform: rawEvidence.platform,
  openVikingVersion: rawEvidence.openVikingVersion,
  vlmSchemaSha256: rawEvidence.vlmSchemaSha256,
  adapterContractSha256: rawEvidence.adapterContractSha256,
  implementation,
  actual: rawEvidence.actual,
  passed,
  checks,
  limitations: rawEvidence.limitations,
});
console.log(`current evidence: ${evidencePath}`);
console.log(JSON.stringify(rawEvidence, null, 2));
if (!passed) process.exitCode = 1;
