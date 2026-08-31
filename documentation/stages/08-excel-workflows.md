# Этап 08 — Полные Excel Workflows

**Статус:** Implemented; physical Excel parity benchmark and native Office.js operation executor pending

**Оценка:** 8–12 чел.-нед.  
**Зависимости:** 06, 07

## Цель

Закрыть основные пользовательские задачи Excel поверх безопасных primitives.

## Scope

- Formula Assistant: generate/explain/fix/simplify/fill;
- cleaning plans: duplicates, spaces, dates, numeric text, missing values;
- sort/filter/find-replace/transpose/normalization;
- professional formatting and conditional formats;
- tables and structured references;
- charts: data selection, aggregation, create/update/delete;
- pivot tables при наличии cross-platform API capability;
- multi-step reporting and dashboard workflows;
- skills/playbooks для reconciliation, budgeting, reporting и merging;
- platform fallbacks и actionable unsupported messages.

## Testing

- scenario tests с expected tools/ChangeSets/final workbook;
- formulas across locales and relative references;
- charts/tables after source range changes;
- destructive cleaning and large-operation previews;
- Windows/Web/macOS parity matrix.

## Exit criteria

- каждый workflow создаёт объяснимый ChangeSet;
- outputs остаются нативными и редактируемыми объектами Excel;
- formula/cleaning/chart benchmark достигает согласованного success rate;
- unsupported capability не приводит к повреждению книги.

## Фактический результат

- добавлен `WorkflowEngine`, который превращает intent в объяснимые ChangeSet operations;
- Formula Assistant поддерживает fill/fix/generate и relative formula generation;
- cleaning plan выполняет trim, localized numeric normalization и duplicate diagnostics с корректным high-risk marking;
- sort workflow создаёт bounded `sort-range` operation;
- table/chart/pivot planners создают native structured operations и отказываются при недоступной capability;
- multi-step report объединяет clean + chart в единый previewable ChangeSet;
- ни один planner не изменяет workbook напрямую — apply остаётся за approved ChangeSet service;
- TDD: 4/4 workflow scenario tests проходят, включая locale formulas, destructive cleaning и unsupported pivots.

Native Office.js executor для table/chart/pivot/format/structure operations и Windows/Web/macOS parity benchmark остаются integration/release increment.
