# Development Setup

## Требования

- Node.js 22 LTS или новее;
- Corepack;
- pnpm версии из `package.json`;
- локальный HTTPS certificate для Office Add-in этапа 02.

## Установка

```bash
corepack enable
corepack prepare
pnpm install --frozen-lockfile
pnpm check
```

До появления lockfile первый владелец dependencies выполняет `pnpm install`, проверяет lockfile и фиксирует его вместе с изменением manifest.

## Правила

- новые контракты начинаются с failing test;
- Office.js разрешён только в `apps/addin` и `packages/excel-adapter-officejs`;
- secrets не имеют `PUBLIC`, `VITE` или аналогичного browser prefix;
- write capability обязана использовать Tool Registry и ChangeSet;
- изменения cross-package API сопровождаются ADR либо RFC;
- tests не используют реальные provider credentials.

## Проверки

`pnpm lint`, `pnpm typecheck`, `pnpm test` и `pnpm build` должны проходить локально и в CI. Foundation tests можно запускать без dependencies командой `node --test tests/foundation/*.test.mjs`.
