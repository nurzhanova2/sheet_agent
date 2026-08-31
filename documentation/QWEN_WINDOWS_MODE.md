# Qwen и Windows authless mode

Windows Excel add-in может работать без регистрации пользователя: оператор один раз задаёт Qwen API key в настройках, а `QwenApiKeyStore` хранит его локально в storage хоста. Ячейки Excel получают только результат функции; ключ не является аргументом формулы и не входит в workbook context.

`QwenProvider` использует OpenAI-compatible Chat Completions API, поддерживает streaming SSE, отмену через `AbortSignal` и настраиваемый endpoint. По умолчанию используется DashScope compatible endpoint; для корпоративного proxy можно указать собственный endpoint.

Authless backend включается только явной настройкой `authMode: "none"` и получает tenant `local` (или `defaultTenantId`). В production multi-user режиме используется `authMode: "required"`.
