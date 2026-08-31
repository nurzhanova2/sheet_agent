# Этап 15 — Qwen key и Windows production integration

## Цель

Подключить пользовательский Qwen API key в Windows Excel add-in после получения ключа, не меняя workbook/tool contracts и не отправляя секрет в telemetry.

## Реализация

- `QwenApiKeyStore` хранит ключ локально в настройках add-in;
- `createConfiguredQwenProvider` создаёт provider только при наличии ключа;
- `createQwenProvider` в `@sheet-agent/llm` выполняет ту же проверку для server/desktop composition;
- Qwen provider использует streaming OpenAI-compatible endpoint;
- ячейки Excel и Custom Functions не принимают API key аргументом;
- серверный enterprise mode может использовать `authMode: "required"` вместо локального ключа.

Фактический ключ намеренно не добавляется в репозиторий и будет введён пользователем после готовности production сборки.
