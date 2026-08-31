# Этап 10 — AI Custom Functions

**Оценка:** 5–8 чел.-нед.  
**Зависимости:** 04 и стабильные contracts этапа 01

## Статус реализации

Реализированы изолированный custom-functions bundle, шесть `AI.*` регистраций, batching/debounce/concurrency, версионируемый TTL-кэш, tenant quota и consent policy, cancellation/stale recalculation guards, детерминированные статусы и HTTP gateway contract. Подробности: [CUSTOM_FUNCTIONS.md](../CUSTOM_FUNCTIONS.md).

## Цель

Добавить AI в grid без создания тысяч неконтролируемых запросов и без write capabilities.

## Scope

- `AI`, `AI.SUMMARIZE`, `AI.CLASSIFY`, `AI.EXTRACT`, `AI.TRANSLATE`, `AI.CLEAN`;
- isolated Custom Functions bundle/runtime;
- request queue, batching, debounce и bounded concurrency;
- cache key/versioning, TTL, eviction и Clear Cache;
- streaming where Excel API supports it;
- cancellation and stale recalculation handling;
- deterministic Excel errors/statuses;
- cost/rate indicators and tenant policies;
- no API keys in cell arguments;
- function metadata, localization и help.

## Testing

- fill-down 1/100/1000 cells;
- cache hits, workbook recalc storms and cancellation;
- provider failures and quota exhaustion;
- privacy consent and tenant disable;
- Windows/Web/macOS capability matrix.

## Exit criteria

- 1000 formula cells не создают 1000 независимых запросов;
- functions никогда не изменяют workbook;
- stale response не перезаписывает новый recalculation result;
- usage ограничивается policy и rate limits.
