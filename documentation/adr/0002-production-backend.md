# ADR 0002 — Production backend обязателен

**Статус:** Accepted  
**Дата:** 2026-08-28

## Контекст

Client-only интеграция раскрывает provider credentials и не даёт централизованных auth, quotas, audit и tenant policies.

## Решение

Production add-in обращается к моделям только через backend. Прямой provider access допустим лишь в явно маркированном local development режиме.

## Последствия и проверка

Secrets не имеют browser/public prefixes и отсутствуют в add-in config contract. Secret scanning и bundle inspection становятся release gates.
