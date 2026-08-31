# ADR 0001 — Office Web Add-in как основной клиент

**Статус:** Accepted  
**Дата:** 2026-08-28

## Контекст

Продукт должен работать в Excel Desktop Windows, Excel Web и macOS. VSTO/COM ограничил бы продукт Windows и создал отдельный runtime.

## Решение

Основной клиент — Office Web Add-in на TypeScript/React/Office.js. Windows-native функции выносятся в optional companion service.

## Последствия и проверка

Office.js изолируется в adapter package и host entry points. CI architecture test запрещает такие импорты в domain/application packages. Платформенные возможности проверяются через Requirement Sets.
