# Этап 04 — Backend, Auth и LLM Gateway

**Статус:** Implemented; external provider and PostgreSQL/Redis integration pending

**Оценка:** 6–9 чел.-нед.  
**Зависимости:** 01; может идти параллельно с 02–03

## Цель

Создать production boundary для моделей, secrets, identity, policy и streaming.

## Scope

- versioned REST API и SSE events;
- authentication и tenant/user context;
- provider-neutral LLM contracts;
- первый OpenAI-compatible adapter;
- normalized messages, tool calls, usage и errors;
- cancellation, timeout, safe retry, rate limits;
- provider/model configuration без передачи keys в add-in;
- privacy consent enforcement;
- PostgreSQL migrations; Redis interface для cache/rate limits;
- health/readiness и structured observability.

## Testing

- provider contract tests и fake provider;
- reconnect/cancel/timeout/rate limit;
- auth and tenant isolation;
- secret redaction and request-size limits.

## Exit criteria

- add-in получает streamed response через backend;
- secrets отсутствуют в bundle, logs и workbook;
- disconnect отменяет downstream request;
- tenant policy блокирует запрещённые models/providers.

## Фактический результат

- добавлены provider-neutral LLM contracts: messages, requests, normalized streaming events, usage и ошибки;
- реализован `LlmGateway` с provider allowlist, timeout и end-to-end `AbortSignal` cancellation;
- добавлен versioned `POST /v1/chat` SSE handler с auth boundary, body-size limit и безопасными JSON errors;
- tenant/user context получается только из bearer token verifier и не принимается из тела запроса;
- добавлен in-memory rate limiter как интерфейсный baseline для последующей Redis-реализации;
- telemetry/API redaction удаляет bearer/API-key паттерны, provider secrets не возвращаются в add-in;
- TDD: 5/5 backend/LLM тестов проходят (provider normalization, timeout, allowlist, auth, SSE);
- реализованы fake-provider тестовые контракты, а реальные OpenAI-compatible adapter, PostgreSQL migrations и Redis backend остаются следующим production integration increment.
