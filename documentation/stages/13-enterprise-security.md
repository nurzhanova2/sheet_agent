# Этап 13 — Enterprise, Security и Compliance

**Оценка:** 7–11 чел.-нед.  
**Зависимости:** 08, 12

## Статус реализации

Реализирован security/compliance increment: tenant policy engine с provider/model allowlist и глобальным egress kill-switch, audit logger с redaction без payload, retention/export/deletion lifecycle store и prompt-injection guard для внешнего текста. Эти controls подключаются к API/MCP gateway через typed contracts; Entra ID, SIEM и подписанный production SBOM остаются release-интеграциями этапа 14.

## Цель

Подготовить систему к корпоративным данным, централизованному управлению и независимой проверке безопасности.

## Scope

- Entra ID SSO, tenant provisioning и RBAC;
- admin policies: providers, models, MCP, local AI, retention, regions;
- audit export and SIEM integration;
- privacy inventory, retention/deletion/export workflows;
- encryption in transit/at rest и key management;
- DLP/sensitivity labels integration where supported;
- prompt-injection and tool-abuse hardening;
- dependency/SBOM/signing/vulnerability pipeline;
- threat model v2, penetration test and remediation;
- incident response, kill switches and provider outage plan;
- legal/license review for reference-derived dependencies.

## Testing

- tenant isolation and privilege escalation;
- full safety benchmark;
- secrets scanning and dependency policies;
- deletion/retention verification;
- audit completeness without sensitive payload.

## Exit criteria

- security review не имеет незакрытых critical/high findings;
- администратор может централизованно отключить любой egress path;
- data lifecycle проверен automated tests;
- signed artifacts и SBOM выпускаются CI.
