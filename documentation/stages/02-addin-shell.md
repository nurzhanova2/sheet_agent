# Этап 02 — Excel Add-in Shell

**Статус:** Implemented; physical Excel smoke matrix pending

**Оценка:** 4–6 чел.-нед.  
**Зависимости:** 01

## Цель

Получить устанавливаемое расширение Excel с устойчивым Task Pane и Ribbon на Windows, Web и macOS.

## Scope

- React, Vite, Fluent UI и Office.js bootstrap;
- development/production manifests, icons и HTTPS hosting;
- Task Pane shell: header, context placeholder, messages, input, status;
- Ribbon commands и shared application composition;
- theme, responsive narrow layout, dark/high-contrast modes;
- Error Boundary, loading/offline/unsupported states;
- Requirement Set capability service;
- sideload/admin deployment guides.

## Testing

- manifest validation;
- component and accessibility tests;
- smoke tests Excel Desktop Windows, Excel Web, macOS;
- startup and bundle-size baseline.

## Exit criteria

- add-in устанавливается и открывается из Ribbon;
- host/platform/capabilities корректно определяются;
- Task Pane не блокирует Excel и восстанавливается после reload;
- startup соответствует установленному performance budget.

## Фактический результат

- созданы отдельные Task Pane и Commands entry points на React/Vite;
- добавлен Fluent UI shell с loading/ready/recoverable error states;
- реализованы Office readiness timeout и Excel host validation;
- capability detection использует Requirement Sets, а не platform sniffing;
- созданы dev/prod manifests и PNG assets 16/32/80;
- оба manifests проходят официальный `office-addin-manifest` validator;
- добавлены narrow-pane, keyboard focus, dark/high-contrast-ready colors и reduced motion;
- TDD red: 7/7 shell tests failing; green: structural и component tests passing;
- production bundle создаёт отдельные `taskpane.html` и `commands.html`.

Физический smoke test внутри Excel Desktop Windows, Excel Web и macOS остаётся release gate: он требует sideload manifest и запуска соответствующего Excel host, что нельзя достоверно заменить jsdom-тестом.
