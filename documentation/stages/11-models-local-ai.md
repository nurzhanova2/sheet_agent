# Этап 11 — Multi-model и Local AI

**Оценка:** 6–9 чел.-нед.  
**Зависимости:** 08, 10

## Статус реализации

Выполнен первый increment этапа: добавлен Qwen OpenAI-compatible provider с SSE streaming, configurable endpoint и AbortSignal; gateway остаётся provider-neutral. Для Windows add-in добавлен явно включаемый authless режим backend и локальное хранилище Qwen API key. Ключ не передаётся в формулы, workbook context или telemetry.

Режим без аутентификации предназначен для локального Windows-приложения с ключом пользователя. Для multi-user/enterprise deployment необходимо оставить `authMode: "required"` и хранить ключи на серверной стороне.

## Цель

Предоставить единое качество и безопасность для облачных и локальных моделей с разными возможностями.

## Scope

- OpenAI, Anthropic, Gemini, OpenRouter adapters;
- generic OpenAI-compatible endpoints;
- model catalog, capability probing и compatibility profiles;
- routing/fallback и provider-specific tool normalization;
- cost/token context display;
- Ollama, LM Studio и vLLM connectors;
- signed Windows Companion для localhost integrations;
- mutual auth, origin allowlist, installer/update/uninstall;
- local-only/offline policy mode;
- model conformance test suite.

## Testing

- contract tests against provider fixtures;
- weak/no-tool model fallback;
- local service unavailable/version mismatch;
- companion authentication and malicious-origin tests;
- offline workflow and data-egress verification.

## Exit criteria

- provider можно сменить без изменения agent/tool contracts;
- capability profile предотвращает unsupported tool behavior;
- companion не принимает произвольный JS/shell;
- external network полностью отключаем tenant/user policy.
