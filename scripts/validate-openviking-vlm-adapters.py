#!/usr/bin/env python3
import json
import os
import sys
from types import SimpleNamespace

from openviking.models.vlm import VLMFactory
from openviking.models.vlm.backends import litellm_vlm
from openviking.models.vlm.backends.codex_responses_adapter import (
    CodexCompletionsAdapter,
    _build_chat_completion_like_response,
    _convert_message_for_responses,
    _convert_tools_for_responses,
)

if len(sys.argv) > 2:
    raise SystemExit("Usage: validate-openviking-vlm-adapters.py [openrouter-model]")
OPENROUTER_MODEL = sys.argv[1] if len(sys.argv) == 2 else "openrouter/validation/model"
PROVIDERS = {
    "volcengine": "VolcEngineVLM",
    "openai": "OpenAIVLM",
    "azure": "OpenAIVLM",
    "kimi": "KimiVLM",
    "glm": "GLMVLM",
    "litellm": "LiteLLMVLMProvider",
    "openai-codex": "CodexVLM",
}
MESSAGES = [
    {"role": "system", "content": "system"},
    {"role": "user", "content": "probe"},
]
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "probe",
            "description": "probe tool",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def response():
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            id="call-probe",
                            function=SimpleNamespace(name="probe", arguments='{"ok":true}'),
                        )
                    ],
                ),
                finish_reason="tool_calls",
            )
        ],
        usage=SimpleNamespace(
            prompt_tokens=1,
            completion_tokens=1,
            total_tokens=2,
            prompt_tokens_details=None,
            completion_tokens_details=None,
        ),
    )


class CompletionEndpoint:
    def __init__(self, calls):
        self.calls = calls

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return response()


def probe_provider(provider):
    config = {"provider": provider, "model": "validation-model", "api_key": "validation-only"}
    if provider == "azure":
        config["api_base"] = "https://example.invalid"
    instance = VLMFactory.create(config)
    if type(instance).__name__ != PROVIDERS[provider]:
        raise AssertionError(f"{provider} resolved to {type(instance).__name__}")

    calls = []
    if provider == "litellm":
        original = litellm_vlm.completion
        litellm_vlm.completion = lambda **kwargs: calls.append(kwargs) or response()
        try:
            result = instance.get_completion(
                messages=MESSAGES, tools=TOOLS, tool_choice="auto"
            )
        finally:
            litellm_vlm.completion = original
    else:
        fake_client = SimpleNamespace(
            chat=SimpleNamespace(completions=CompletionEndpoint(calls))
        )
        instance.get_client = lambda: fake_client
        result = instance.get_completion(
            messages=MESSAGES, tools=TOOLS, tool_choice="auto"
        )

    request = calls[0]
    if request["messages"] != MESSAGES:
        raise AssertionError(f"{provider} changed message semantics")
    if request["tools"] != TOOLS or request["tool_choice"] != "auto":
        raise AssertionError(f"{provider} changed tool semantics")
    if not result.has_tool_calls or result.tool_calls[0].name != "probe":
        raise AssertionError(f"{provider} did not parse function calls")
    if result.tool_calls[0].arguments != {"ok": True}:
        raise AssertionError(f"{provider} changed function arguments")
    return type(instance).__name__


def probe_litellm_routing():
    detected = VLMFactory.create({"provider": "litellm", "model": "claude-3-7-sonnet", "api_key": "validation-only"})
    native = VLMFactory.create({"provider": "litellm", "model": "bedrock/anthropic.claude-v2", "api_key": "validation-only"})
    custom = VLMFactory.create(
        {
            "provider": "litellm",
            "model": "custom-model",
            "api_base": "https://example.invalid/v1",
            "api_key": "validation-only",
        }
    )
    source_environment = VLMFactory.create({"provider": "litellm", "model": "deepseek/deepseek-chat"})
    keyword_conflict = VLMFactory.create({"provider": "litellm", "model": "custom/gemini-proxy"})
    zai_alias = VLMFactory.create({"provider": "litellm", "model": "zai/glm-4.7"})
    ollama = VLMFactory.create({"provider": "litellm", "model": "ollama/qwen3:8b"})
    ollama_request = ollama._build_text_kwargs(messages=MESSAGES)
    return {
        "detectedPrefix": detected._resolve_model(detected.model) == "anthropic/claude-3-7-sonnet",
        "genericCredentialMapped": os.environ.get("ANTHROPIC_API_KEY") == "validation-only"
        and detected._should_forward_api_key(detected.model),
        "sourceEnvironmentDelegated": source_environment.api_key is None
        and not source_environment._should_forward_api_key(source_environment.model),
        "keywordConflictObserved": keyword_conflict._resolve_model(keyword_conflict.model) == "gemini/custom/gemini-proxy",
        "zaiAliasPreserved": zai_alias._resolve_model(zai_alias.model) == "zai/glm-4.7",
        "nativeRoutePreserved": native._resolve_model(native.model) == "bedrock/anthropic.claude-v2"
        and not native._should_forward_api_key(native.model),
        "customOpenAICompatible": custom._resolve_model(custom.model) == "openai/custom-model"
        and custom._should_forward_api_key(custom.model),
        "ollamaDefaults": isinstance(ollama_request.get("extra_body", {}).get("num_ctx"), int)
        and ollama_request["extra_body"]["num_ctx"] > 0,
    }

def probe_codex_translation():
    converted_tools = _convert_tools_for_responses(TOOLS)
    converted_messages = _convert_message_for_responses(MESSAGES[1])
    final = SimpleNamespace(
        output=[
            SimpleNamespace(
                type="function_call",
                call_id="call-probe",
                name="probe",
                arguments='{"ok":true}',
            )
        ],
        usage=SimpleNamespace(input_tokens=1, output_tokens=1, total_tokens=2),
    )
    converted_response = _build_chat_completion_like_response(final, "validation-model")
    tool_call = converted_response.choices[0].message.tool_calls[0]
    return (
        converted_tools == [
            {
                "type": "function",
                "name": "probe",
                "description": "probe tool",
                "parameters": {"type": "object", "properties": {}},
            }
        ]
        and converted_messages == [{"role": "user", "content": "probe"}]
        and tool_call.function.name == "probe"
        and tool_call.function.arguments == '{"ok":true}'
    )


class _EmptyResponseStream:
    def __iter__(self):
        return iter(())

    def close(self):
        return None


def probe_codex_request_semantics():
    calls = []

    class ResponsesEndpoint:
        def create(self, **kwargs):
            calls.append(kwargs)
            return _EmptyResponseStream()

    client = SimpleNamespace(responses=ResponsesEndpoint())
    adapter = CodexCompletionsAdapter(lambda: client, "validation-model")
    adapter.create(
        messages=MESSAGES,
        tools=TOOLS,
        tool_choice="auto",
        temperature=0.0,
        reasoning_effort="low",
        thinking=False,
        stream=False,
    )
    request = calls[0]
    return {
        "reasoningForwarded": any(key in request for key in ("reasoning", "reasoning_effort", "thinking")),
        "temperatureForwarded": "temperature" in request,
        "stream": request.get("stream"),
        "store": request.get("store"),
    }


def probe_litellm_openrouter_request_semantics():
    calls = []
    instance = VLMFactory.create(
        {
            "provider": "litellm",
            "model": OPENROUTER_MODEL,
            "api_key": "validation-only",
        }
    )
    original = litellm_vlm.completion
    litellm_vlm.completion = lambda **kwargs: calls.append(kwargs) or response()
    try:
        instance.get_completion(messages=MESSAGES, tools=TOOLS, tool_choice="auto")
    finally:
        litellm_vlm.completion = original
    request = calls[0]
    return {
        "model": request.get("model"),
        "apiKeyForwarded": request.get("api_key") == "validation-only",
        "reasoningForwarded": any(key in request for key in ("reasoning", "reasoning_effort", "thinking")),
        "temperatureForwarded": isinstance(request.get("temperature"), (int, float)),
        "temperature": request.get("temperature"),
        "timeoutForwarded": isinstance(request.get("timeout"), (int, float)),
    }


classes = {provider: probe_provider(provider) for provider in PROVIDERS}
codex_request = probe_codex_request_semantics()
litellm_openrouter_request = probe_litellm_openrouter_request_semantics()
litellm_routing = probe_litellm_routing()
litellm_routing_passed = all(
    litellm_routing[name]
    for name in (
        "detectedPrefix",
        "genericCredentialMapped",
        "sourceEnvironmentDelegated",
        "keywordConflictObserved",
        "zaiAliasPreserved",
        "nativeRoutePreserved",
        "customOpenAICompatible",
        "ollamaDefaults",
    )
)
result = {
    "passed": probe_codex_translation()
    and litellm_routing_passed
    and litellm_openrouter_request == {
        "model": OPENROUTER_MODEL,
        "apiKeyForwarded": True,
        "reasoningForwarded": False,
        "temperatureForwarded": True,
        "temperature": 0.0,
        "timeoutForwarded": True,
    }
    and codex_request == {
        "reasoningForwarded": False,
        "temperatureForwarded": False,
        "stream": True,
        "store": False,
    },
    "litellmRoutes": litellm_routing,
    "providers": classes,
    "messages": True,
    "tools": True,
    "toolChoice": True,
    "functionCalls": True,
    "codexResponsesTranslation": True,
    "litellmOpenRouterRequest": litellm_openrouter_request,
    "codexRequest": codex_request,
}
print(json.dumps(result, separators=(",", ":")))
if not result["passed"]:
    raise SystemExit(1)
