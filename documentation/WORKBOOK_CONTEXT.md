# Workbook Context и безопасное чтение

## Граница архитектуры

`excel-tools` и будущий agent runtime зависят только от `ExcelPort` из application layer. Реальный Office.js находится в `excel-adapter-officejs`; тесты используют `testkit` mock adapter. Благодаря этому agent-facing код не может выполнять произвольный Office.js.

Поток данных:

`Office.js → OfficeJsExcelPort → WorkbookContextManager / ReadToolRegistry → Agent`

## Progressive disclosure

Task Pane автоматически получает только активный лист, адрес и размеры selection. Содержимое ячеек читается лишь через явный read tool:

- `excel.getWorkbookOverview`;
- `excel.readSelection`;
- `excel.readRange`;
- `excel.readFormulas`;
- `excel.readTable`;
- `excel.search`.

По умолчанию один ответ ограничен 2 000 ячеек, 24 000 символов и chunks по 100 строк. Лимиты можно уменьшить для конкретной сессии. Результат сообщает `truncated` и `returnedCellCount`, чтобы агент мог запросить следующий узкий диапазон вместо сериализации всей книги.

## Trust и аудит

Все workbook values имеют метку `untrusted-workbook-data`. Текст вроде «ignore previous instructions» не интерпретируется инфраструктурой как команда. Audit metadata намеренно не содержит значений или формул: сохраняются операция, длительность, запрошенный адрес, количество возвращённых ячеек и факт усечения.

Workbook ID вычисляется из tenant scope и source identity через SHA-256. URL/имя файла не должны попадать в agent-facing overview или audit log.

## Reference alignment

- Pi for Excel: единый tool registry и selection-aware context;
- Office Agents: изолированный Excel package и расширяемые built-in tools;
- Claude Sidebar: live selection context в Task Pane;
- MS Excel AI Plugin: schema/capability checks и audit boundary.

В отличие от референсов, автоматический context здесь не содержит cell values, а arbitrary Office.js evaluation отсутствует.
