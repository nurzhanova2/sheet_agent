# Agent Runtime и Sessions

Runtime находится между backend LLM Gateway и application Tool Registry. Он не импортирует Office.js и не вызывает provider SDK напрямую.

```text
prompt → thinking → tool-call → permission/allowlist → tool-result → observe → answer
                    ↘ failed/cancelled
```

Один run имеет correlation ID `${tenantId}:${sessionId}`. Лимиты являются application-owned: `maxSteps=8`, `maxTools=12`, output 16k и context 32k символов по умолчанию. При исчерпании лимита runtime возвращает стабильный error code, а не продолжает loop.

Tool result добавляется в следующий model context как ограниченный `tool` message. Workbook content не попадает в session record; session хранит только пользовательский scope, заголовок и bounded summary.

## Reference alignment

Tool loop и изолированный Excel package следуют Office Agents; session/compaction boundary и per-workbook correlation вдохновлены Pi for Excel. Selection/read permission остаются application-owned согласно архитектуре проекта.
