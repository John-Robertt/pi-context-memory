#!/usr/bin/env python3
import hashlib
import json
import sys
from copy import deepcopy

from openviking import __version__ as openviking_version
from openviking.models.vlm.registry import get_all_provider_names
from openviking.models.vlm.backends.litellm_vlm import (
    EXPLICIT_LITELLM_PREFIXES,
    NATIVE_AUTH_LITELLM_PREFIXES,
    PROVIDER_CONFIGS,
)
from openviking_cli.utils.config.open_viking_config import OpenVikingConfig
from openviking_cli.utils.config.vlm_config import VLMConfig

CREDENTIAL_ENV = "PCR_OPENVIKING_VLM_API_KEY"
SETTING_FIELDS = frozenset({"provider", "model", "api_base", "api_version"})
CONNECTION_FIELDS = {
    "volcengine": {"required": [], "optional": ["api_base"]},
    "openai": {"required": [], "optional": ["api_base"]},
    "azure": {"required": ["api_base"], "optional": ["api_version"]},
    "kimi": {"required": [], "optional": ["api_base"]},
    "glm": {"required": [], "optional": ["api_base"]},
    "litellm": {"required": [], "optional": ["api_base"]},
    "openai-codex": {"required": [], "optional": ["api_base"]},
}


def stable_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def vlm_properties():
    schema = VLMConfig.model_json_schema()
    root = schema
    reference = schema.get("$ref")
    if reference:
        for segment in reference.removeprefix("#/").split("/"):
            root = root[segment]
    return schema, root["properties"]


def describe_litellm_routes():
    recognized = []
    for source, config in PROVIDER_CONFIGS.items():
        prefix = config["litellm_prefix"]
        patterns = (
            [f"{prefix}/<model-id>"]
            if prefix
            else ["<OpenAI-model-id>", "openai/<model-id>"]
        )
        recognized.append(
            {
                "source": source,
                "modelPatterns": patterns,
                "keywords": list(config["keywords"]),
                "credentialEnvironment": config["env_key"],
            }
        )
    return {
        "catalogUrl": "https://docs.litellm.ai/docs/providers",
        "recognized": recognized,
        "explicit": [
            {
                "prefix": prefix.removesuffix("/"),
                "nativeAuthentication": prefix in NATIVE_AUTH_LITELLM_PREFIXES,
            }
            for prefix in EXPLICIT_LITELLM_PREFIXES
        ],
        "specialModelPatterns": [
            {"source": "zhipu", "modelPattern": "zai/<glm-model-id>"},
        ],
        "customOpenAICompatible": {
            "modelPattern": "openai/<model-id>",
            "apiBaseRequired": True,
        },
    }

def describe():
    providers = get_all_provider_names()
    if set(providers) != set(CONNECTION_FIELDS):
        missing = sorted(set(providers) - set(CONNECTION_FIELDS))
        obsolete = sorted(set(CONNECTION_FIELDS) - set(providers))
        raise ValueError(
            f"OpenViking provider policy is out of date (missing={missing}, obsolete={obsolete})"
        )
    schema, properties = vlm_properties()
    return {
        "openVikingVersion": openviking_version,
        "providers": [
            {
                "name": provider,
                **CONNECTION_FIELDS[provider],
                "credential": (
                    "optional-environment-or-native"
                    if provider == "litellm"
                    else "environment-or-native"
                    if provider == "openai-codex"
                    else "environment"
                ),
            }
            for provider in providers
        ],
        "settingFields": {
            name: properties[name]
            for name in ("provider", "model", "api_base", "api_version")
        },
        "vlmSchemaSha256": stable_hash(schema),
        "credentialEnvironment": CREDENTIAL_ENV,
        "litellmRoutes": describe_litellm_routes(),
    }


def normalized_setting(value):
    if not isinstance(value, dict):
        raise ValueError("Memory model setting must be a JSON object")
    unknown = sorted(set(value) - SETTING_FIELDS)
    if unknown:
        raise ValueError(f"Unknown memory model setting fields: {', '.join(unknown)}")

    capabilities = describe()
    provider = value.get("provider")
    model = value.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("Memory model provider is required")
    provider = provider.strip().lower()
    provider_names = [item["name"] for item in capabilities["providers"]]
    if provider not in provider_names:
        raise ValueError(f"Unknown OpenViking VLM provider: {provider}")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Memory model ID is required")

    result = {"provider": provider, "model": model.strip()}
    descriptor = next(item for item in capabilities["providers"] if item["name"] == provider)
    accepted_connections = set(descriptor["required"] + descriptor["optional"])
    for field in ("api_base", "api_version"):
        raw = value.get(field)
        if raw is None or raw == "":
            continue
        if field not in accepted_connections:
            raise ValueError(f"{field} is not supported for OpenViking provider {provider}")
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"{field} must be a non-empty string")
        result[field] = raw.strip().rstrip("/") if field == "api_base" else raw.strip()
    for field in descriptor["required"]:
        if field not in result:
            raise ValueError(f"OpenViking provider {provider} requires {field}")
    return result


def compile_config(payload):
    if not isinstance(payload, dict):
        raise ValueError("Compiler input must be a JSON object")
    base_config = payload.get("baseConfig")
    if not isinstance(base_config, dict):
        raise ValueError("Base OpenViking configuration must be a JSON object")
    setting = normalized_setting(payload.get("setting"))
    credential_available = payload.get("credentialAvailable") is True

    provider = setting["provider"]
    if provider not in {"litellm", "openai-codex"} and not credential_available:
        raise ValueError(f"{CREDENTIAL_ENV} is required for OpenViking provider {provider}")

    vlm = {
        "provider": provider,
        "model": setting["model"],
        "temperature": 0.0,
        "max_retries": 3,
        "thinking": False,
        "stream": False,
    }
    for field in ("api_base", "api_version"):
        if field in setting:
            vlm[field] = setting[field]
    if credential_available:
        vlm["api_key"] = f"${{{CREDENTIAL_ENV}}}"

    generated = deepcopy(base_config)
    generated["vlm"] = vlm
    OpenVikingConfig.from_dict(deepcopy(generated))
    return {
        "config": generated,
        "provider": provider,
        "model": setting["model"],
        "settingsFingerprint": stable_hash(setting),
        "configFingerprint": stable_hash(generated),
    }


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    if command == "describe":
        result = describe()
    elif command == "compile":
        result = compile_config(json.load(sys.stdin))
    else:
        raise ValueError("Usage: openviking-config.py describe|compile")
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


try:
    main()
except Exception as error:
    json.dump({"error": str(error)}, sys.stderr, ensure_ascii=False)
    sys.stderr.write("\n")
    sys.exit(1)
