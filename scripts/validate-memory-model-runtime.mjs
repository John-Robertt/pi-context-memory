#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  atomicWriteJson,
  compileOpenVikingConfig,
  OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS,
  OPENVIKING_RUNTIME_SCHEMA_VERSION,
  describeMemoryModelCapabilities,
  ensureMemoryModelConfig,
  memoryModelConfigContentFingerprint,
  memoryModelConfigPath,
  readLauncherInfo,
  readMemoryModelSetting,
  readRuntimeState,
  requestOpenVikingRestart,
} from "../.pi/extensions/pi-context-memory/memory-model-configuration.ts";
import {
  assertImplementationEvidenceUnchanged,
  captureImplementationEvidence,
  STABLE_EVIDENCE_SCHEMA_VERSION,
} from "./validation-evidence.mjs";
import {
  assertValidationPiVersion,
  createIsolatedPiProviderCredential,
  readProjectOpenVikingVersion,
} from "./validation-suite.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("Usage: node scripts/validate-memory-model-runtime.mjs");
const piVersion = assertValidationPiVersion(root);
const expectedOpenVikingVersion = readProjectOpenVikingVersion(root);
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
    [VALIDATION_API_KEY_ENV]: VALIDATION_API_KEY,
    PCR_OPENVIKING_READINESS_TIMEOUT_MS: "1200",
    PCR_OPENVIKING_STOP_TIMEOUT_MS: "800",
    PCR_OPENVIKING_CHILD_STDIO: "ignore",
  };
}

function createFakeServer(path) {
  writeFileSync(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
const configPath = process.argv[process.argv.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const model = config.vlm?.model ?? "source-recall-only";
if (model === "exit-early") process.exit(17);
const started = Date.now();
const server = createServer((request, response) => {
  if (request.url !== "/health") { response.writeHead(404).end(); return; }
  const delayed = model === "slow-ready" && Date.now() - started < 500;
  const unavailable = model.startsWith("never-ready") || delayed;
  response.writeHead(unavailable ? 503 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: unavailable ? "starting" : "ok", healthy: !unavailable, version: ${JSON.stringify(expectedOpenVikingVersion)} }));
});
server.listen(config.server.port, config.server.host);
if (model.includes("ignore-term")) process.on("SIGTERM", () => undefined);
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
  const providerDefaultsNotOverridden = compiled.every((item) =>
    !["thinking", "temperature", "max_retries", "stream"].some((field) => Object.hasOwn(item.config.vlm, field))
  );
  const deterministicSetting = { provider: "volcengine", model: "validation-model", api_key: VALIDATION_API_KEY_REFERENCE };
  const deterministicFingerprint = compiled[0].configFingerprint
    === (await compileOpenVikingConfig(root, deterministicSetting, env)).configFingerprint;
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
  const apiKeyFormsPreserved = directApiKey.config.vlm.api_key === "literal-validation-key"
    && referencedApiKey.config.vlm.api_key === VALIDATION_API_KEY_REFERENCE
    && bracedReferencedApiKey.config.vlm.api_key === VALIDATION_API_KEY_BRACED_REFERENCE
    && new Set([
      directApiKey.configFingerprint,
      referencedApiKey.configFingerprint,
      bracedReferencedApiKey.configFingerprint,
    ]).size === 3;
  const referenceConfigPath = join(caseDir, "reference-openviking.json");
  const bracedReferenceConfigPath = join(caseDir, "braced-reference-openviking.json");
  writeJson(referenceConfigPath, referencedApiKey.config);
  writeJson(bracedReferenceConfigPath, bracedReferencedApiKey.config);
  const loaderProbe = spawnSync(
    pythonCommand,
    [
      "-c",
      "import json,sys; from pathlib import Path; from openviking_cli.utils.config.config_loader import load_json_config; print(json.dumps([load_json_config(Path(path))['vlm']['api_key'] for path in sys.argv[1:]]))",
      referenceConfigPath,
      bracedReferenceConfigPath,
    ],
    { cwd: root, encoding: "utf8", env },
  );
  const environmentReferencesExpanded = loaderProbe.status === 0
    && JSON.parse(loaderProbe.stdout).every((value) => value === VALIDATION_API_KEY);
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
  const codexNativeCredentialPreserved = !Object.hasOwn(codexNativeConfig.config.vlm, "api_key");
  const apiKeysBoundToSettings = compiled.every((item) => item.provider === "openai-codex" || item.provider === "litellm"
    ? !Object.hasOwn(item.config.vlm, "api_key")
    : item.config.vlm.api_key === VALIDATION_API_KEY_REFERENCE);

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
      providerDefaultsNotOverridden,
      deterministicFingerprint,
      environmentReferencesExpanded,
      apiKeyFormsPreserved,
      apiKeysBoundToSettings,
      codexNativeCredentialPreserved,
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
    provider: "litellm",
    model: "openrouter/validation/model",
  }, false);
  const missingCredentialLauncher = startLauncher(missingCredentialEnv);
  let missingCredentialState;
  try {
    missingCredentialLauncher.stderr.resume();
    missingCredentialLauncher.stdout.resume();
    missingCredentialState = await waitFor(async () => {
      const state = await readRuntimeState(root, missingCredentialEnv);
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
  await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, {
    provider: "openai",
    model: "initial-model",
    api_key: VALIDATION_API_KEY,
    api_base: "https://example.invalid/v1",
  });
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
    const generatedRuntimeSource = readFileSync(env.PCR_OPENVIKING_GENERATED_CONFIG, "utf8");
    const initialLauncherInfo = await readLauncherInfo(root, env);
    const runtimeCredentialsProtected = (statSync(env.PCR_MEMORY_MODEL_SETTINGS).mode & 0o777) === 0o600
      && (statSync(env.PCR_OPENVIKING_GENERATED_CONFIG).mode & 0o777) === 0o600
      && generatedRuntimeSource.includes(VALIDATION_API_KEY)
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
    const desiredConfigDoesNotDisableRunning = invalidConfigStatuses.includes("增强记忆 · 生效中")
      && !invalidConfigStatuses.includes("Pi 原生");
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "second-model", api_base: "https://example.invalid/v1" });
    const second = await requestOpenVikingRestart(root, env);
    const orderedRestart = second.ready === true
      && second.childPid !== firstChildPid
      && second.configurationError === undefined
      && !processAlive(firstChildPid);

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, {
      provider: "openai",
      model: "credential-boundary",
      api_key: VALIDATION_API_KEY_REFERENCE,
    });
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
    const splitCredentialRuntimeRemainsAvailable = credentialBoundaryState.ready === true
      && credentialBoundaryState.activeProvider === "openai"
      && credentialBoundaryStatuses.includes("增强记忆 · 生效中")
      && !credentialBoundaryStatuses.includes("Pi 原生")
      && credentialBoundaryPiCase.events.some((event) => event.type === "extension_ui_request"
        && event.method === "notify"
        && event.message.includes("Configuration: applied"));

    const wrongInfo = await readLauncherInfo(root, env);
    const operationDeadlinePublished = wrongInfo.operationTimeoutMs === OPENVIKING_CONFIG_BRIDGE_TIMEOUT_MS
      + (4 * Number(env.PCR_OPENVIKING_STOP_TIMEOUT_MS))
      + Number(env.PCR_OPENVIKING_READINESS_TIMEOUT_MS)
      + 5_000;
    const wrongResponse = await fetch(`${wrongInfo.controlUrl}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchId: "wrong-launch" }),
    });
    const wrongLaunchRejected = wrongResponse.status === 403 && second.ready;
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "slow-ready", api_base: "https://example.invalid/v1" });
    const interruptedRequest = httpRequest(`${wrongInfo.controlUrl}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    interruptedRequest.once("error", () => undefined);
    interruptedRequest.end(JSON.stringify({ launchId: wrongInfo.launchId, operationId: "interrupted-operation" }));
    await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.phase === "restarting" && state.targetModel === "slow-ready" && state.operationId === "interrupted-operation" ? state : undefined;
    }, "accepted interrupted restart");
    interruptedRequest.destroy();
    const afterInterruptedControl = await waitFor(async () => {
      const state = await readRuntimeState(root, env);
      return state?.ready && state.activeModel === "slow-ready" && state.operationId === "interrupted-operation" ? state : undefined;
    }, "interrupted restart completion");
    const interruptedControlOperationCompletes = afterInterruptedControl.childPid !== second.childPid
      && !processAlive(second.childPid);

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, {
      provider: "openai",
      model: "command-model",
      api_key: VALIDATION_API_KEY,
      api_base: "https://example.invalid/v1",
    });
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
      && event.message.includes("openai/command-model"));
    const configuredAndRunningDistinct = piCase.events.some((event) => event.type === "extension_ui_request"
      && event.method === "notify"
      && event.message.includes("Configured memory model: openai/command-model")
      && event.message.includes("Running OpenViking model: openai/slow-ready")
      && event.message.includes("Context path: Pi 原生"));
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, null);
    const nullPiCase = await runPiCommandCase(join(caseDir, "pi-null-config"), env, [
      "/memory-model",
      "/restart-viking",
      "/memory-model",
    ]);
    const nullNotifications = nullPiCase.events.filter((event) => event.type === "extension_ui_request"
      && event.method === "notify");
    const nullConfigurationStateReported = nullNotifications.some((event) => event.message.includes("Configured memory model: not configured")
      && event.message.includes("Running OpenViking model: openai/command-model")
      && event.message.includes("Configuration: waiting for /restart-viking"))
      && nullNotifications.some((event) => event.message.includes("Configured memory model: not configured")
        && event.message.includes("Running OpenViking model: no VLM loaded")
        && event.message.includes("Configuration: applied"))
      && !nullPiCase.observations.some((row) => row.type === "before_provider_request");
    const statusEvents = [...piCase.events, ...secondPiCase.events, ...nullPiCase.events].filter((event) => event.type === "extension_ui_request"
      && event.method === "setStatus");
    const statusTexts = statusEvents.map((event) => event.statusText);
    const memoryStatusLifecycleVisible = statusTexts.includes("增强记忆 · 初始化中")
      && statusTexts.includes("增强记忆 · 生效中")
      && statusTexts.includes("Pi 原生")
      && statusTexts.every((status) => status === undefined
        || status === "增强记忆 · 初始化中"
        || status === "增强记忆 · 生效中"
        || status === "增强记忆"
        || status === "Pi 原生");

    console.error("[memory-model-runtime] restart failure matrix");
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "slow-ready", api_base: "https://example.invalid/v1" });
    const concurrent = await Promise.allSettled([
      requestOpenVikingRestart(root, env),
      requestOpenVikingRestart(root, env),
    ]);
    const concurrentRestartSerialized = concurrent.filter((item) => item.status === "fulfilled").length === 1
      && concurrent.filter((item) => item.status === "rejected").length === 1;

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "ignore-term", api_base: "https://example.invalid/v1" });
    await requestOpenVikingRestart(root, env);
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "never-ready-ignore-term", api_base: "https://example.invalid/v1" });
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
      && timedOutState.targetModel === "never-ready-ignore-term";

    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "recovered", api_base: "https://example.invalid/v1" });
    const recovered = await requestOpenVikingRestart(root, env);
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "exit-early", api_base: "https://example.invalid/v1" });
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
    await writeMemoryModelConfig(env.PCR_MEMORY_MODEL_SETTINGS, { provider: "openai", model: "final", api_base: "https://example.invalid/v1" });
    const finalState = await requestOpenVikingRestart(root, env);
    const ownedChild = finalState.childPid;
    launcher.kill("SIGTERM");
    launcher.kill("SIGHUP");
    await waitForExit(launcher);
    const launcherLogsExcludeCredentials = !Buffer.concat(launcherOutput).toString("utf8").includes(VALIDATION_API_KEY);
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
        targetPortPreflightPreservesInstance,
        preflightPreservesInstance,
        orderedRestart,
        runtimeCredentialsProtected,
        launcherLogsExcludeCredentials,
        operationDeadlinePublished,
        operationDeadlineCoversFailureCleanup,
        wrongLaunchRejected,
        interruptedControlOperationCompletes,
        automaticConfigErrorReported,
        desiredConfigDoesNotDisableRunning,
        openRouterLauncherCredentialRequired,
        splitCredentialRuntimeRemainsAvailable,
        commandNoProviderRequests,
        taskModelUnchanged,
        branchUnchanged,
        piSessionCredentialsExcluded,
        configCommandReadOnly,
        sharedUserConfig,
        configuredAndRunningDistinct,
        nullConfigurationStateReported,
        memoryStatusLifecycleVisible,
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
      '{ "memoryModel": { "provider": "openai", "model": "cold-start-model", "api_key": "$MISSING_COLD_START_API_KEY" } }\n',
      { encoding: "utf8", mode: 0o600 },
    );
    coldLauncher = startLauncher(coldEnv);
    coldLauncher.stdout.resume();
    coldLauncher.stderr.resume();
    const coldState = await waitFor(async () => {
      const state = await readRuntimeState(root, coldEnv);
      return state?.ready ? state : undefined;
    }, "invalid cold-start source-only fallback", 20_000);
    const invalidColdStartFallsBack = coldState.activeModel === undefined
      && coldState.configurationError?.includes("api_key references unset environment variable MISSING_COLD_START_API_KEY")
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
    return { checks: { unknownPortPreserved, launcherOwnershipProtected, staleLifecycleLockRequiresExplicitRecovery, invalidColdStartFallsBack, unrelatedReadyNotReconciled } };
  } finally {
    if (coldLauncher) await stopLauncher(coldLauncher).catch(() => undefined);
    if (resetServer?.listening) await new Promise((resolveClose) => resetServer.close(resolveClose));
    await stopLauncher(occupiedLauncher).catch(() => undefined);
    await new Promise((resolveClose) => occupant.close(resolveClose));
  }
}

const startedAt = new Date().toISOString();
console.error("[memory-model-runtime] configuration");
const configuration = await validateConfiguration();
console.error("[memory-model-runtime] launcher and Pi commands");
const launcher = await validateLauncherAndCommands();
console.error("[memory-model-runtime] ownership boundaries");
const ownership = await validateOwnershipBoundaries();
const checks = { ...configuration.checks, ...launcher.checks, ...ownership.checks };
const passed = Object.values(checks).every(Boolean);
const completedAt = new Date().toISOString();
const rawEvidence = {
  schemaVersion: STABLE_EVIDENCE_SCHEMA_VERSION,
  generatedBy: "scripts/validate-memory-model-runtime.mjs",
  scope: "local",
  runId,
  startedAt,
  completedAt,
  piVersion,
  nodeVersion: process.versions.node,
  openVikingVersion: configuration.capabilities.openVikingVersion,
  vlmSchemaSha256: configuration.capabilities.vlmSchemaSha256,
  adapterContractSha256: configuration.capabilities.adapterContractSha256,
  implementation,
  passed,
  checks,
  limitations: [
    "The local scope uses a protocol-compatible OpenViking process double and makes no external Provider requests.",
    "Working Memory protocol and automatic Pi context adoption have separate local evidence; the paired quality runner records the selected real memory adapter semantics.",
    "One fixed paired task-quality sample exists; general task quality and complete API-cost attribution remain outside this local runner.",
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
  openVikingVersion: rawEvidence.openVikingVersion,
  vlmSchemaSha256: rawEvidence.vlmSchemaSha256,
  adapterContractSha256: rawEvidence.adapterContractSha256,
  implementation,
  passed,
  checks,
  limitations: rawEvidence.limitations,
});
console.log(`current evidence: ${evidencePath}`);
console.log(JSON.stringify(rawEvidence, null, 2));
if (!passed) process.exitCode = 1;
