# Этап 12 — MCP, Skills и Python Sandbox

**Оценка:** 8–12 чел.-нед.  
**Зависимости:** 11 и security review

## Статус реализации

Этап завершён: пакет `@sheet-agent/extensibility` содержит MCP registry и JSON-RPC HTTP transport, per-server/tool allowlist, consent и provenance; versioned trusted Skills registry с проверкой подписи и rollback; policy-first Python sandbox HTTP executor с лимитами timeout/memory/output и обязательным отключением сети. Add-in обращается к sandbox только через отдельный endpoint, а не выполняет Python локально.

## Цель

Расширять агента внешними данными и тяжёлым анализом без разрушения основной trust model.

## Scope

- MCP gateway и connection catalog;
- per-server/tool permissions и consent;
- external tool provenance в UI/audit;
- skills registry, versioning и declarative workflows;
- signed/trusted versus untrusted skill policy;
- Python sandbox service для pandas/numpy/scipy;
- resource/time/memory/network/filesystem limits;
- structured input/output instead of arbitrary host execution;
- artifacts and Excel visualization handoff;
- kill switch and tenant allowlists.

## Testing

- malicious MCP responses and prompt injection;
- tool name collisions and schema changes;
- sandbox escape, timeout, memory and output limits;
- skill upgrade/rollback and signature validation;
- data provenance and consent flows.

## Exit criteria

- внешняя интеграция не получает workbook data без scope/consent;
- Python не выполняется на основной машине без sandbox;
- все результаты имеют source/tool provenance;
- integration/skill можно отключить без обновления add-in.
