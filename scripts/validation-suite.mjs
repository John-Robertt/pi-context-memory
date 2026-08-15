import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VALIDATION_SUITE_PATH = "validation/suite.json";
const PROJECT_METADATA_PATH = "pyproject.toml";

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain only ${wanted.join(", ")}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requireProvider(value, label) {
  const provider = requireNonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(provider)) throw new Error(`${label} is invalid`);
  return provider;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function readValidationSuite(root) {
  const suite = JSON.parse(readFileSync(resolve(root, VALIDATION_SUITE_PATH), "utf8"));
  requireExactKeys(
    suite,
    ["schemaVersion", "host", "modelSelection", "diagnostics", "policy"],
    VALIDATION_SUITE_PATH,
  );
  if (suite.schemaVersion !== 1) throw new Error(`${VALIDATION_SUITE_PATH} schemaVersion is unsupported`);

  requireExactKeys(suite.host, ["pi"], `${VALIDATION_SUITE_PATH} host`);
  requireExactKeys(suite.host.pi, ["version", "protocolProfile"], `${VALIDATION_SUITE_PATH} host.pi`);
  const piVersion = requireNonEmptyString(suite.host.pi.version, `${VALIDATION_SUITE_PATH} host.pi.version`);
  const piProtocolProfile = requireNonEmptyString(
    suite.host.pi.protocolProfile,
    `${VALIDATION_SUITE_PATH} host.pi.protocolProfile`,
  );

  requireExactKeys(suite.modelSelection, ["route", "task", "memory"], `${VALIDATION_SUITE_PATH} modelSelection`);
  const route = requireNonEmptyString(suite.modelSelection.route, `${VALIDATION_SUITE_PATH} modelSelection.route`);
  if (route.startsWith("/") || route.endsWith("/") || !route.includes("/")) {
    throw new Error(`${VALIDATION_SUITE_PATH} modelSelection.route must use provider/model format`);
  }
  requireExactKeys(suite.modelSelection.task, ["provider", "thinking"], `${VALIDATION_SUITE_PATH} modelSelection.task`);
  requireExactKeys(
    suite.modelSelection.memory,
    ["provider", "routePrefix"],
    `${VALIDATION_SUITE_PATH} modelSelection.memory`,
  );
  const taskProvider = requireProvider(
    suite.modelSelection.task.provider,
    `${VALIDATION_SUITE_PATH} modelSelection.task.provider`,
  );
  const taskThinking = requireNonEmptyString(
    suite.modelSelection.task.thinking,
    `${VALIDATION_SUITE_PATH} modelSelection.task.thinking`,
  );
  const memoryProvider = requireProvider(
    suite.modelSelection.memory.provider,
    `${VALIDATION_SUITE_PATH} modelSelection.memory.provider`,
  );
  const memoryRoutePrefix = requireProvider(
    suite.modelSelection.memory.routePrefix,
    `${VALIDATION_SUITE_PATH} modelSelection.memory.routePrefix`,
  );

  requireExactKeys(
    suite.diagnostics,
    ["pairedQualityRepetitions"],
    `${VALIDATION_SUITE_PATH} diagnostics`,
  );
  const pairedQualityRepetitions = requirePositiveInteger(
    suite.diagnostics.pairedQualityRepetitions,
    `${VALIDATION_SUITE_PATH} diagnostics.pairedQualityRepetitions`,
  );

  requireExactKeys(
    suite.policy,
    ["longTaskFixtureKinds", "eligibleTarget", "deterministicTimingSamples"],
    `${VALIDATION_SUITE_PATH} policy`,
  );
  if (!Array.isArray(suite.policy.longTaskFixtureKinds)
    || suite.policy.longTaskFixtureKinds.length === 0
    || suite.policy.longTaskFixtureKinds.some((kind) => typeof kind !== "string" || !kind.trim())
    || new Set(suite.policy.longTaskFixtureKinds).size !== suite.policy.longTaskFixtureKinds.length) {
    throw new Error(`${VALIDATION_SUITE_PATH} policy.longTaskFixtureKinds must contain unique non-empty strings`);
  }

  return {
    schemaVersion: suite.schemaVersion,
    host: { pi: { version: piVersion, protocolProfile: piProtocolProfile } },
    models: {
      route,
      task: `${taskProvider}/${route}`,
      taskProvider,
      taskThinking,
      memory: `${memoryProvider}/${memoryRoutePrefix}/${route}`,
      memoryProvider,
      memoryRoute: `${memoryRoutePrefix}/${route}`,
    },
    diagnostics: { pairedQualityRepetitions },
    policy: {
      longTaskFixtureKinds: [...suite.policy.longTaskFixtureKinds],
      eligibleTarget: requirePositiveInteger(
        suite.policy.eligibleTarget,
        `${VALIDATION_SUITE_PATH} policy.eligibleTarget`,
      ),
      deterministicTimingSamples: requirePositiveInteger(
        suite.policy.deterministicTimingSamples,
        `${VALIDATION_SUITE_PATH} policy.deterministicTimingSamples`,
      ),
    },
  };
}

export function readValidationModels(root) {
  const { models } = readValidationSuite(root);
  return {
    task: models.task,
    memory: models.memory,
  };
}

export function readProjectOpenVikingVersion(root) {
  const source = readFileSync(resolve(root, PROJECT_METADATA_PATH), "utf8");
  const matches = [...source.matchAll(/^\s*"openviking\[local-embed\]==([^"\s]+)"\s*,?\s*$/gmu)];
  if (matches.length !== 1) {
    throw new Error(`${PROJECT_METADATA_PATH} must contain exactly one exact openviking[local-embed] dependency`);
  }
  return matches[0][1];
}

export function observePiVersion(options = {}) {
  const run = options.run ?? spawnSync;
  const result = run(options.piCommand ?? "pi", ["--version"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  const version = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status !== 0 || !version || /[\r\n]/u.test(version)) {
    throw new Error(result.stderr?.trim() || "Pi version is unavailable");
  }
  return version;
}

export function assertValidationPiVersion(root, options = {}) {
  const expected = readValidationSuite(root).host.pi.version;
  const actual = observePiVersion({ cwd: root, ...options });
  if (actual !== expected) {
    throw new Error(`Validation suite requires Pi ${expected}; found ${actual}`);
  }
  return actual;
}

export function createIsolatedPiProviderCredential(providerId, environmentVariable, options = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId)) throw new Error("Invalid Pi provider ID");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentVariable)) {
    throw new Error("Invalid isolated credential environment variable");
  }
  const run = options.run ?? spawnSync;
  const result = run(options.piCommand ?? "pi", [
    "auth",
    "print-api-key",
    "--provider",
    providerId,
  ], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const apiKey = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status !== 0 || !apiKey || /[\r\n]/u.test(apiKey)) {
    throw new Error(`Pi has no usable ${providerId} API key; authenticate with /login ${providerId}`);
  }
  return {
    reference: `\${${environmentVariable}}`,
    environment: { [environmentVariable]: apiKey },
  };
}
