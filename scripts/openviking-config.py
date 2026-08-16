#!/usr/bin/env python3
import hashlib
import json
import sys
from pathlib import Path
from copy import deepcopy

from openviking import __version__ as openviking_version
from openviking_cli.utils.config import OpenVikingConfig, VLMConfig
OPENVIKING_MEMORY_API_KEY_ENV = "PCR_OPENVIKING_MEMORY_API_KEY"
OPENVIKING_MEMORY_API_KEY_REFERENCE = f"${{{OPENVIKING_MEMORY_API_KEY_ENV}}}"
ADAPTER_CONTRACT_PATH = Path(__file__).resolve().parents[1] / "config" / "openviking-adapter-contract.json"


def adapter_contract():
    contract = json.loads(ADAPTER_CONTRACT_PATH.read_text(encoding="utf-8"))
    if contract.get("schemaVersion") != 1:
        raise ValueError("OpenViking adapter contract schemaVersion is unsupported")
    setting_fields = contract.get("settingFields")
    providers = contract.get("providers")
    if not isinstance(setting_fields, list) or not setting_fields or len(setting_fields) != len(set(setting_fields)):
        raise ValueError("OpenViking adapter contract settingFields are invalid")
    if not isinstance(providers, list) or not providers:
        raise ValueError("OpenViking adapter contract providers are invalid")
    provider_names = []
    for descriptor in providers:
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("name"), str):
            raise ValueError("OpenViking adapter contract contains an invalid provider")
        provider_names.append(descriptor["name"])
        if descriptor.get("credential") not in {
            "api-key",
            "api-key-or-native",
            "optional-api-key-or-native",
        }:
            raise ValueError(f"OpenViking adapter contract credential is invalid for {descriptor['name']}")
        for field in ("required", "optional", "apiKeyRequiredModelPrefixes"):
            values = descriptor.get(field)
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise ValueError(f"OpenViking adapter contract {field} is invalid for {descriptor['name']}")
    if len(provider_names) != len(set(provider_names)):
        raise ValueError("OpenViking adapter contract repeats a provider")
    return contract


def stable_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def redacted_error(error, secrets):
    message = str(error)
    for secret in secrets:
        if isinstance(secret, str) and secret:
            message = message.replace(secret, "<redacted>")
    return message

def vlm_properties():
    schema = VLMConfig.model_json_schema()
    root = schema
    reference = schema.get("$ref")
    if reference:
        for segment in reference.removeprefix("#/").split("/"):
            root = root[segment]
    return schema, root["properties"]


def describe():
    contract = adapter_contract()
    schema, properties = vlm_properties()
    schema_hash = stable_hash(schema)
    if schema_hash != contract.get("vlmSchemaSha256"):
        raise ValueError("OpenViking VLM schema does not match the reviewed adapter contract")
    return {
        "openVikingVersion": openviking_version,
        "providers": [
            {
                "name": descriptor["name"],
                "required": descriptor["required"],
                "optional": descriptor["optional"],
                "credential": descriptor["credential"],
                "apiKeyRequiredModelPrefixes": descriptor["apiKeyRequiredModelPrefixes"],
            }
            for descriptor in contract["providers"]
        ],
        "settingFields": {
            name: properties[name]
            for name in contract["settingFields"]
        },
        "vlmSchemaSha256": schema_hash,
        "adapterContractSha256": stable_hash(contract),
        "litellmCatalogUrl": contract["litellmCatalogUrl"],
    }


def requires_api_key(descriptor, model):
    if descriptor["credential"] == "api-key":
        return True
    normalized_model = model.lower()
    return any(
        normalized_model.startswith(prefix.lower())
        for prefix in descriptor["apiKeyRequiredModelPrefixes"]
    )

def normalized_setting(value):
    if not isinstance(value, dict):
        raise ValueError("Memory model setting must be a JSON object")
    capabilities = describe()
    unknown = sorted(set(value) - set(capabilities["settingFields"]))
    if unknown:
        raise ValueError(f"Unknown memory model setting fields: {', '.join(unknown)}")

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
    api_key = value.get("api_key")
    if api_key is not None and api_key != "":
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("api_key must be a non-empty string")
        result["api_key"] = api_key.strip()
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
    runtime_profile = payload.get("runtimeProfile")
    profile_fields = {
        "profileVersion", "provider", "model", "api", "thinking", "temperature", "stream",
        "maxOutputTokens", "requestTimeoutMs", "maxRetries", "maxConcurrency", "adapterVersion",
    }
    if not isinstance(runtime_profile, dict) or set(runtime_profile) != profile_fields:
        raise ValueError("MemoryRuntimeProfile fields are invalid")
    if runtime_profile["provider"] != setting["provider"] or runtime_profile["model"] != setting["model"]:
        raise ValueError("MemoryRuntimeProfile does not match the memory model target")
    if runtime_profile["api"] != "openviking-vlm" or runtime_profile["thinking"] is not False \
            or runtime_profile["temperature"] != 0 or runtime_profile["stream"] is not False:
        raise ValueError("MemoryRuntimeProfile request semantics are unsupported")
    for field in ("profileVersion", "maxOutputTokens", "requestTimeoutMs", "maxConcurrency"):
        if not isinstance(runtime_profile[field], int) or runtime_profile[field] <= 0:
            raise ValueError(f"MemoryRuntimeProfile {field} must be a positive integer")
    if not isinstance(runtime_profile["maxRetries"], int) or runtime_profile["maxRetries"] < 0:
        raise ValueError("MemoryRuntimeProfile maxRetries must be a non-negative integer")
    if not isinstance(runtime_profile["adapterVersion"], str) or not runtime_profile["adapterVersion"]:
        raise ValueError("MemoryRuntimeProfile adapterVersion is invalid")

    provider = setting["provider"]
    api_key = setting.get("api_key")
    descriptor = next(
        item for item in describe()["providers"]
        if item["name"] == provider
    )
    api_key_required = requires_api_key(descriptor, setting["model"])
    if api_key_required and not api_key:
        raise ValueError(f"api_key is required for OpenViking provider {provider}")
    credential_secrets = [api_key] if api_key else []
    vlm = {
        "provider": provider,
        "model": setting["model"],
        "thinking": runtime_profile["thinking"],
        "temperature": runtime_profile["temperature"],
        "stream": runtime_profile["stream"],
        "max_tokens": runtime_profile["maxOutputTokens"],
        "timeout": runtime_profile["requestTimeoutMs"] / 1000,
        "max_retries": runtime_profile["maxRetries"],
        "max_concurrent": runtime_profile["maxConcurrency"],
    }
    if api_key:
        vlm["api_key"] = OPENVIKING_MEMORY_API_KEY_REFERENCE
    for field in ("api_base", "api_version"):
        if field in setting:
            vlm[field] = setting[field]

    generated = deepcopy(base_config)
    generated["vlm"] = vlm
    try:
        OpenVikingConfig.from_dict(deepcopy(generated))
    except Exception as error:
        raise ValueError(redacted_error(error, credential_secrets)) from None
    return {
        "config": generated,
        "provider": provider,
        "model": setting["model"],
        "settingsFingerprint": stable_hash(setting),
        "profile": runtime_profile,
        "profileFingerprint": stable_hash(runtime_profile),
        "configFingerprint": stable_hash({
            "config": generated,
            "runtimeProfile": runtime_profile,
            "credentialFingerprint": stable_hash(api_key) if api_key else None,
        }),
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
