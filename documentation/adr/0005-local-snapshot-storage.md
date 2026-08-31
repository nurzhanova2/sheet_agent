# ADR 0005 — Snapshots хранятся локально и ограниченно

**Статус:** Accepted  
**Дата:** 2026-08-28

## Контекст

Rollback требует before-state, но отправка snapshots на backend увеличивает риск утечки workbook contents.

## Решение

Snapshots остаются на клиенте, шифруются средствами доступного platform storage и имеют TTL, per-workbook quota и size limit. Backend хранит только audit metadata.

## Последствия и проверка

Большие операции могут быть отклонены либо потребовать специального механизма snapshot. Tests проверяют eviction, quota, expiry и отсутствие cell contents в backend payloads.
