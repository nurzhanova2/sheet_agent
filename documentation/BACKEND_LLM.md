# Backend и LLM Gateway

Поток запроса: `Add-in → POST /v1/chat → authenticate → tenant policy → LlmGateway → provider adapter → SSE`.

## Границы

Provider credentials никогда не находятся в add-in bundle, workbook или request body как доверенный источник. `AuthContext` строится verifier-ом из bearer token; tenant ID не принимается от клиента.

Gateway принимает только нормализованный `ChatRequest` и отдаёт `StreamEvent`: `delta`, `tool-call`, `done`, `error`. Provider SDK должен быть добавлен за `LlmProvider` adapter и не должен просачиваться в agent/application packages.

## Безопасность и эксплуатация

- max request body — 256 KB по умолчанию;
- timeout — 60 секунд по умолчанию;
- downstream cancellation передаётся через AbortSignal;
- provider allowlist блокирует запрещённые модели/provider;
- SSE не кэшируется;
- secrets redacted перед streaming/audit output;
- rate limiter сейчас in-memory, production deployment должен заменить его Redis-backed реализацией;
- auth verifier сейчас dependency-injected, production использует OIDC/JWT с JWKS rotation.

## Reference alignment

Provider-neutral gateway и streaming следуют boundary-подходу из Pi for Excel и Office Agents. Auth/policy boundary учитывает enterprise-подход MS Excel AI Plugin. Архитектура не копирует SDK-код из reference repositories и сохраняет backend ownership над secrets.
