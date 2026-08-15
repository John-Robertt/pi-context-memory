import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VALIDATION_MODEL_CONFIG_PATH = "validation/model.json";

export function readValidationModels(root) {
  const config = JSON.parse(readFileSync(resolve(root, VALIDATION_MODEL_CONFIG_PATH), "utf8"));
  if (!config || Array.isArray(config) || Object.keys(config).join(",") !== "openRouterModel") {
    throw new Error(`${VALIDATION_MODEL_CONFIG_PATH} must contain only openRouterModel`);
  }
  const openRouterModel = config.openRouterModel?.trim();
  if (!openRouterModel || openRouterModel.startsWith("/") || openRouterModel.endsWith("/") || !openRouterModel.includes("/")) {
    throw new Error(`${VALIDATION_MODEL_CONFIG_PATH} openRouterModel must use provider/model format`);
  }
  return {
    openRouterModel,
    task: `openrouter/${openRouterModel}`,
    memory: `litellm/openrouter/${openRouterModel}`,
  };
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
