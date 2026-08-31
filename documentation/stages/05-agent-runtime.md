# Этап 05 — Agent Runtime и Sessions

**Статус:** Implemented; persistent session backend and production model integration pending

**Оценка:** 6–8 чел.-нед.  
**Зависимости:** 03, 04

## Цель

Реализовать управляемый многошаговый агент, который работает только через зарегистрированные tools.

## Scope

- explicit AgentState и state machine;
- tool loop: plan → validate → execute → observe → continue/answer;
- step/tool/time/token/result-size limits;
- application-owned tool permissions;
- streaming activity events;
- Stop/AbortSignal end-to-end;
- sessions, rename/delete/resume;
- context compression и safe workbook memory;
- per-workbook read/write coordination interface;
- deterministic replay/debug trace без sensitive payload.

## Testing

- multi-step happy paths;
- invalid/hallucinated tools and malformed args;
- infinite loop/limit exhaustion;
- cancellation at every state;
- session isolation across workbooks/users.

## Exit criteria

- агент отвечает на вопросы через реальные read tools;
- tool вне registry выполнить невозможно;
- лимиты и cancellation гарантированно останавливают цикл;
- session restore не восстанавливает полный workbook content.

## Фактический результат

- добавлен explicit `AgentStatus`/`AgentEvent` state machine с состояниями thinking, reading, completed, failed и cancelled;
- реализован ограниченный loop `plan → tool-call → tool-result → observe → answer` поверх provider-neutral gateway;
- runtime сам владеет tool allowlist и передаёт read permission в registry, поэтому hallucinated tools выполнить нельзя;
- добавлены max steps, max tool calls, context/output character budgets и end-to-end cancellation;
- streaming activity events не содержат полные workbook snapshots и пригодны для deterministic debug trace;
- `InMemorySessionStore` поддерживает list/resume/rename/delete с изоляцией user/tenant/workbook scope;
- session records хранят bounded summary, а не полный workbook content;
- TDD: 6/6 Agent Runtime и Session тестов проходят: happy path, unknown tool, loop exhaustion, cancellation, output limit и isolation;
- persistent PostgreSQL session repository, compressed memory policy и production retry orchestration остаются integration increment backend слоя.
