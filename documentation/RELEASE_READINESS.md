# Release readiness

Этап 14 добавляет формализованные performance budgets, staged rollout (`internal` → `pilot` → `ga`) и promotion guard, который блокирует продвижение при data-loss incident или error rate выше 2%.

Перед GA необходимо выполнить manual Excel matrix, backup/restore drill, signed installer, SBOM, deployment rollback и on-call runbook.
