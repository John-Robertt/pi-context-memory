#!/usr/bin/env python3
import hashlib
import json
import sys
from copy import deepcopy

from openviking import __version__ as openviking_version
from openviking_cli.utils.config import OpenVikingConfig, VLMConfig

OPENVIKING_MEMORY_API_KEY_ENV = "PCR_OPENVIKING_MEMORY_API_KEY"
OPENVIKING_MEMORY_API_KEY_REFERENCE = f"${{{OPENVIKING_MEMORY_API_KEY_ENV}}}"
USER_SETTING_FIELDS = ("provider", "model", "api_key", "api_base", "api_version")




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
    schema, properties = vlm_properties()
    missing = [name for name in USER_SETTING_FIELDS if name not in properties]
    if missing:
        raise ValueError(f"OpenViking VLM schema is missing required configuration fields: {', '.join(missing)}")
    return {
        "openVikingVersion": openviking_version,
        "settingFields": {name: properties[name] for name in USER_SETTING_FIELDS},
        "vlmSchemaSha256": stable_hash(schema),
    }



def normalized_setting(value):
    if not isinstance(value, dict):
        raise ValueError("Memory model setting must be a JSON object")
    unknown = sorted(set(value) - set(USER_SETTING_FIELDS))
    if unknown:
        raise ValueError(f"Unknown memory model setting fields: {', '.join(unknown)}")

    provider = value.get("provider")
    model = value.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("Memory model provider is required")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Memory model ID is required")

    result = {"provider": provider.strip().lower(), "model": model.strip()}
    api_key = value.get("api_key")
    if api_key is not None and api_key != "":
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("api_key must be a non-empty string")
        result["api_key"] = api_key.strip()
    for field in ("api_base", "api_version"):
        raw = value.get(field)
        if raw is None or raw == "":
            continue
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"{field} must be a non-empty string")
        result[field] = raw.strip().rstrip("/") if field == "api_base" else raw.strip()
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
        validated = OpenVikingConfig.from_dict(deepcopy(generated))
        validated.vlm.get_vlm_instance()
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
