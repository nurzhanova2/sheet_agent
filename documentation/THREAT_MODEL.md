# Threat Model v1

## Защищаемые активы

- содержимое workbook и его структура;
- provider/user/tenant credentials;
- целостность формул, значений и объектов Excel;
- conversation/session metadata;
- audit integrity и tenant policies.

## Trust boundaries

Workbook cells, пользовательский prompt, attachments, LLM output, MCP responses и Python output являются untrusted input. Add-in, backend и optional companion — разные trust zones. Переход каждой границы требует validation и минимального payload.

## Основные угрозы и меры

| Угроза | Мера |
|---|---|
| Prompt injection в ячейке | Data/instruction separation; permissions вне LLM |
| Exfiltration всей книги | Progressive reads, range/context limits, consent |
| Несанкционированная запись | Registry → ChangeSet → approval → executor |
| Повторная/частичная запись | operation ID, serialization, read-back, rollback |
| Secret leakage | server-side secrets, redaction, no workbook logging |
| Malicious tool arguments | versioned schema validation and allowlist |
| Companion/MCP abuse | mutual auth, scopes, origin/tool allowlists |
| Sandbox escape | isolated process/container and resource limits |
| Tenant crossover | scoped identity, authorization and partition tests |

## Out of scope этапа 01

Конкретная auth implementation, криптографический storage и sandbox выбираются в последующих этапах. До их появления соответствующие feature flags выключены.

Threat model пересматривается перед этапами 07, 11, 12 и production GA.
