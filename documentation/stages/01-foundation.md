# Этап 01 — Foundation и архитектурные контракты

**Статус:** Completed (2026-08-28)

**Оценка:** 3–5 чел.-нед.  
**Зависимости:** нет

## Цель

Сделать воспроизводимую инженерную основу и зафиксировать правила, которые нельзя обходить в следующих этапах.

## Scope

- pnpm/Turborepo monorepo, TypeScript strict mode;
- lint, format, unit tests, build и dependency boundaries;
- CI для Windows/Linux runners и проверка Office manifest;
- environment/config strategy и secret handling;
- versioned schemas для tools, events, ChangeSet и API;
- error taxonomy, IDs, logging и feature flags;
- ADR: Office Web Add-in, backend boundary, ChangeSet, streaming, storage;
- threat model v1 и data classification;
- development HTTPS certificates и local setup.

## Deliverables

- все packages собираются пустыми typed entry points;
- CI блокирует циклические и запрещённые зависимости;
- шаблоны ADR, RFC и security review;
- architecture test: Office.js импортируется только разрешённым adapter package.

## Exit criteria

- clean checkout поднимается одной документированной последовательностью команд;
- build, lint, typecheck и tests проходят в CI;
- схемы имеют versioning policy;
- владельцы модулей и review rules определены.

## Фактический результат

- создан strict TypeScript workspace из 13 приложений/пакетов;
- добавлены ESLint, Turborepo, pnpm lockfile и Windows/Linux CI;
- определены v1 schemas: tool call/result, agent event, ChangeSet и API error;
- добавлены branded correlation IDs, error catalog, safe config и opt-in feature flags;
- architecture tests запрещают Office.js за пределами host/adapter;
- приняты ADR 0001–0005, threat model и data classification;
- TDD red: 9 failing / 1 passing; green: полный check проходит.

## Риски

- преждевременное усложнение monorepo;
- расхождение frontend/backend типов;
- отсутствие Windows runner скрывает packaging-проблемы.
