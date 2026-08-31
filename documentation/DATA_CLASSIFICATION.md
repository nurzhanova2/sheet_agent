# Data Classification

## Классы

1. **Secret:** provider credentials, auth tokens, encryption keys. Только secret manager/server memory; запрещены client bundle, workbook, telemetry и обычные logs.
2. **Workbook Content:** values, formulas, comments, attachments и snapshots. Читается по intent, передаётся минимально, не логируется по умолчанию.
3. **Sensitive Metadata:** workbook/user/tenant IDs, sheet/range names, conversation summaries. Хранится с access control и retention.
4. **Operational Metadata:** timings, error codes, counts, model/tool names. Разрешено для telemetry после redaction.
5. **Public:** документация, schemas и обезличенные fixtures.

## Правила потоков

Workbook Content может отправляться внешнему provider только после consent и tenant policy check. Snapshot не покидает клиентскую границу. Audit хранит tool name, arguments summary и affected range, но не before/after values. Любой новый persistence или integration path требует privacy review.

## Retention baseline

Secrets живут согласно secret-manager policy. Tool payloads краткоживущие. Sessions и metadata получают configurable retention. Local snapshots имеют короткий TTL и quota. Пользователь/администратор должен иметь delete/export controls до production rollout.
