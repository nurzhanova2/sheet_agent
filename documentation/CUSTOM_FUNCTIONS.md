# AI Custom Functions

Stage 10 adds an isolated Office.js Custom Functions runtime. `AI`, `AI.SUMMARIZE`, `AI.CLASSIFY`, `AI.EXTRACT`, `AI.TRANSLATE`, and `AI.CLEAN` are registered from `custom-functions.html`; the runtime never receives an API key from a cell and never writes to the workbook.

`CustomFunctionService` batches fill-down calls, debounces bursts, limits concurrency, applies tenant quotas, caches by contract version/tenant/function/locale/input, and exposes `clearCache()`. Older recalculation generations return `#STALE!`; cancelled requests use `#CANCELLED!`. Other deterministic statuses are `#CONSENT!`, `#QUOTA!`, `#INVALID!`, and `#AI!`.

`HttpCustomFunctionGateway` posts bounded batches to `/v1/custom-functions`; provider credentials remain server-side.

Function names and localized-help-ready descriptions are published in `apps/addin/public/custom-functions.json` and exposed by both manifest environments.
