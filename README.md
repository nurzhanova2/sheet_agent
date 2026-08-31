# Sheet Agent

AI Assistant for Microsoft Excel implemented as an Office Web Add-in.

The repository is currently an architecture scaffold. Product requirements and design documents are in [`documentation`](./documentation/).

- [System architecture](./documentation/ARCHITECTURE.md)
- [Full implementation plan](./documentation/IMPLEMENTATION_PLAN.md)
- [Reference implementations](./documentation/REFERENCES.md)

## Applications

- `apps/addin` — Excel Task Pane, Ribbon commands and Custom Functions runtime.
- `apps/server` — production API, policies and LLM gateway.
- `apps/windows-companion` — optional Windows-local integration; not part of MVP.

## Shared packages

Domain and infrastructure boundaries live in `packages`. Office.js may only be imported by `packages/excel-adapter-officejs` and Excel host entry points.
