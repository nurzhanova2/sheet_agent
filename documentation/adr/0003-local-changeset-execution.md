# ADR 0003 — ChangeSet исполняется локально в add-in

**Статус:** Accepted  
**Дата:** 2026-08-28

## Контекст

Backend и LLM не должны владеть прямым каналом записи в workbook. Между preview и Apply workbook может измениться.

## Решение

Backend предлагает типизированные operations. Add-in повторно валидирует ChangeSet, показывает diff, получает approval, проверяет preconditions и применяет операции через Office.js adapter.

## Последствия и проверка

Все write tools возвращают proposal. Integration tests подтверждают отсутствие записи до approval, conflict при изменённом before-state и rollback при failed verification.
