# Этап 06 — Deterministic Analysis Engine

**Статус:** Implemented; production streaming worker and benchmark corpus pending

**Оценка:** 6–9 чел.-нед.  
**Зависимости:** 03; интеграция требует 05

## Цель

Перенести вычисления из LLM в проверяемые локальные алгоритмы и выдавать модели компактные результаты.

## Scope

- schema/type inference;
- descriptive/numeric statistics;
- missing values, duplicates и value counts;
- correlation и configurable outlier detection;
- time-series summary и trend candidates;
- formula errors, gaps и inconsistent patterns;
- cleaning diagnostics без автоматического заполнения пропусков;
- chunked/streaming analysis больших диапазонов;
- evidence references к конкретным ranges/rows.

## Testing

- golden datasets и property-based tests;
- dates/locales/numbers stored as text;
- statistical edge cases, sparse and constant columns;
- deterministic repeatability;
- performance and memory budgets.

## Exit criteria

- `Analyze this table` строится из deterministic evidence;
- каждое утверждение может ссылаться на result/range;
- LLM не получает задачу самостоятельно считать статистику;
- большие ranges не замораживают UI.

## Фактический результат

- реализованы deterministic schema/type inference для numbers, localized numeric strings, dates, booleans, strings, mixed и empty columns;
- добавлены count, missing, invalid, unique/value counts, min/max/mean/median и standard deviation;
- реализованы duplicate rows, Pearson correlation и configurable robust outlier detection (IQR + MAD);
- добавлены bounded sampling по `maxRows` и trend candidates с направлением и slope;
- formula diagnostics находят Excel errors, gaps и inconsistent row references;
- каждый metric result содержит range-scoped evidence reference и не выполняет cleaning/write;
- TDD: 4/4 golden analysis tests проходят, включая deterministic repeatability, locale parsing и edge cases;
- production worker/streaming execution для сверхбольших ranges и расширенный benchmark corpus остаются следующим performance increment.
