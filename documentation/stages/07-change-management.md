# Этап 07 — ChangeSet и безопасная запись

**Статус:** Implemented; persistent history and full Office.js write primitives pending

**Оценка:** 8–12 чел.-нед.  
**Зависимости:** 05

## Цель

Создать транзакционно-подобный механизм для всех AI-изменений workbook.

## Scope

- typed ChangeSet/operations/risk model;
- ChangeSet builder и validator;
- bounded before/after diff;
- explicit approve/reject и destructive confirmation;
- preconditions/optimistic concurrency;
- snapshots: values, formulas и поддерживаемое formatting state;
- serialized idempotent executor;
- recalculation и read-back verification;
- automatic rollback и user Undo;
- history, retention, TTL и storage quotas;
- write tools: range/formula/format/structure primitives.

## Testing

- duplicate Apply, refresh and network interruption;
- workbook changes between preview and approval;
- partial Office.js failure;
- formula error verification;
- rollback fidelity for every operation type;
- protected sheets and concurrent sessions.

## Exit criteria

- ни один AI write не выполняется до approval;
- failed verification возвращает workbook к snapshot;
- Apply идемпотентен;
- destructive operation требует отдельного UI action;
- committed change можно отменить в пределах retention policy.

## Фактический результат

- реализованы typed ChangeSet proposal, operation/risk model и bounded cell-level `diffSnapshots`;
- запись невозможна до explicit `approve`; high-risk changes требуют отдельного destructive confirmation;
- перед Apply выполняется optimistic concurrency check по before-state;
- executor сериализует операции по workbook/sheet key и повторный Apply committed ChangeSet идемпотентен;
- перед записью сохраняется bounded snapshot, после write выполняются recalculate и read-back verification;
- verification failure автоматически восстанавливает snapshot и переводит ChangeSet в `rolled_back`;
- committed ChangeSet поддерживает пользовательский Undo;
- retention TTL и protected-sheet/Office errors проходят через типизированный error boundary;
- TDD: 5/5 ChangeSet тестов проходят: preview, approval, conflict, idempotency/undo и rollback.

Production persistent history/quota storage и расширенные formula/format/structure Office.js write primitives остаются следующим integration increment.
