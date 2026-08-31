# Deterministic Analysis Engine

Analysis выполняется локально на bounded matrix после `ExcelPort` read. LLM получает evidence, а не задачу самостоятельно считать статистику.

Поддерживаются:

- schema inference и invalid/missing diagnostics;
- descriptive numeric statistics и value counts;
- duplicate row detection;
- Pearson correlations;
- IQR/MAD outliers;
- sampled trend candidates;
- formula errors, gaps и inconsistent relative references.

Отчёт содержит `range`, `rowsAnalyzed`, `sampled`, metrics и `evidence`. Evidence не включает содержимое ячеек в telemetry; range остаётся ссылкой для проверки пользователем.

`maxRows` ограничивает память и время. Cleaning diagnostics только предлагают кандидатов — изменение workbook будет возможно позже через ChangeSet.

Reference alignment: локальная детерминированная аналитика соответствует архитектурному разделению Excel tools/analysis из Office Agents и privacy boundary проекта.
