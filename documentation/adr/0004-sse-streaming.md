# ADR 0004 — SSE для server-to-client streaming

**Статус:** Accepted  
**Дата:** 2026-08-28

## Контекст

Основной realtime поток однонаправленный: backend отправляет token/status/tool events add-in. Команды клиента остаются обычными HTTP requests.

## Решение

Использовать versioned SSE AgentEvent stream. WebSocket добавляется только при подтверждённой двунаправленной realtime потребности.

## Последствия и проверка

Events имеют conversation/run/event IDs. Contract tests проверяют reconnect, ordering, cancellation и duplicate event handling.
