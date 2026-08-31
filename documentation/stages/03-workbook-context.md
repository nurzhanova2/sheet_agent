# Этап 03 — Workbook Context и Read Tools

**Статус:** Implemented; physical Excel performance validation pending

**Оценка:** 5–7 чел.-нед.  
**Зависимости:** 02

## Цель

Создать единственный безопасный путь чтения workbook без автоматической сериализации всей книги.

## Scope

- `ExcelPort` и Office.js adapter;
- Workbook/Selection managers и event debouncing;
- stable workbook identity;
- overview: sheets, tables, named ranges, charts, pivots;
- read tools: selection/range/table/formulas/search;
- progressive context, chunking, sampling и payload budgets;
- compact structured tool results;
- permission/capability/schema validation;
- mock Excel adapter и workbook fixtures.

## Testing

- empty, hidden, protected и large sheets;
- localized values/formulas и mixed cell types;
- selection changes during reads;
- unsupported Requirement Sets;
- prompt-injection strings остаются data.

## Exit criteria

- UI показывает sheet, range и размеры менее чем за performance budget;
- Agent-facing код не импортирует Office.js;
- ни один read tool не превышает context limits;
- все reads имеют structured audit metadata без содержимого ячеек.

## Фактический результат

- введён независимый от Office.js порт `ExcelPort` для selection, range, table, formulas, search и workbook overview;
- реализован production adapter `OfficeJsExcelPort`; Office.js импортируется только adapter/add-in слоями;
- `WorkbookContextManager` публикует лёгкий selection context с debounce и корректной отпиской;
- workbook identity строится как tenant-scoped SHA-256 identifier без раскрытия URL книги;
- read-tool registry проверяет аргументы, read permission и host capabilities;
- значения книги маркируются как `untrusted-workbook-data`, поэтому prompt-injection-подобные строки остаются данными;
- большие диапазоны ограничиваются cell/character budgets, sampling и row chunks;
- audit metadata содержит только операцию, длительность, адрес и счётчики, но не значения ячеек;
- добавлены mock Excel adapter и fixtures для hidden/protected/large/localized/mixed workbooks;
- Task Pane показывает активный лист, адрес и размеры выделения и обновляет их по событиям Excel;
- TDD red зафиксирован до реализации: 8/8 новых тестов падали; green: 8/8 проходят.

Физическая проверка performance budget в Excel Desktop Windows/Web/macOS остаётся release gate, поскольку требует реального sideload и GUI host.
