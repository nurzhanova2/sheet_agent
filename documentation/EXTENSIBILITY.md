# Extensibility trust model

`@sheet-agent/extensibility` изолирует внешние интеграции от Office.js. MCP-сервер регистрируется с endpoint и списком разрешённых tools; `McpHttpTransport` вызывает только разрешённый JSON-RPC `tools/call`, вызов требует consent и workbook scope, а результат получает provenance.

Skills устанавливаются только после `SkillSignatureVerifier`, поддерживают версии и rollback. Python запускается через `HttpSandboxExecutor`/инъецированный `SandboxExecutor`; policy запрещает сеть и задаёт timeout, memory и output limits, а большие artifacts отклоняются. Add-in не выполняет произвольный Python на основной машине.
