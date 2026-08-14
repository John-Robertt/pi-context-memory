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
