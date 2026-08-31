# Enterprise security controls

`TenantPolicyEngine` централизованно управляет провайдерами, моделями, MCP, local AI и egress. `disableEgress()` отключает все внешние пути для tenant и работает как kill switch.

`AuditLogger` пишет только actor/action/outcome и безопасные metadata; секреты редактируются, workbook/prompt payload намеренно не сохраняется. `DataLifecycleStore` поддерживает retention purge, tenant export и deletion.

Внешний MCP/connector text проходит `guardExternalText`, который блокирует распространённые prompt-injection и tool-abuse инструкции. Полный Entra ID/SIEM/KMS/SBOM pipeline подключается на production rollout.
