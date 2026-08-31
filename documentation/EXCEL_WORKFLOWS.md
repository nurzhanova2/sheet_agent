# Excel Workflows

Workflow layer переводит пользовательский intent в ChangeSet. Planner не вызывает Excel write API.

Поддерживаемые сценарии:

- `formulaAssist`: fill/fix/generate с relative references;
- `clean`: trim, localized numeric normalization, duplicate removal;
- `sort`: deterministic ordering;
- `createTable`, `createChart`, `createPivot`: native Excel object operations с capability guard;
- `report`: multi-step composition в один preview.

Риск операции вычисляется до approval: duplicate removal — high, normalization — medium, formula fill/sort — low. При недоступном Requirement Set workflow возвращает `CAPABILITY_UNAVAILABLE` и не меняет книгу.

Архитектурно это продолжает подход MS Excel AI Plugin (объяснимые edits) и Excel Labs (нативные редактируемые Excel outputs), но сохраняет обязательный ChangeSet approval boundary проекта.
