# ChangeSet и безопасная запись

Любая AI-запись проходит цепочку:

`propose → diff/preview → approve → snapshot → precondition check → apply → recalculate → verify → commit`

При ошибке verification выполняется `restoreRange(snapshot)`, а ChangeSet получает статус `rolled_back`. Неподтверждённый или rejected ChangeSet не вызывает write API.

`ChangeSetService` принимает только `WritableExcelPort`; Office.js остаётся за adapter boundary. Внутри одного workbook операции ставятся в последовательную очередь. Повторный вызов для committed ID возвращает существующий результат без повторной записи.

High-risk operation нельзя подтвердить обычным approve: нужен отдельный `destructiveConfirmed` флаг, который UI должен запросить явным действием.

Reference alignment: preview/undo модель следует MS Excel AI Plugin, сериализация и recovery checkpoint — Pi for Excel. В production следует подключить persistent history с TTL/quota и расширить adapter для formulas/format/structure.
