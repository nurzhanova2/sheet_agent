# Reference implementations

This project uses the repositories below as design references, not as code copied into the project. Before reusing source code, its license and attribution requirements must be reviewed.

## Pi for Excel

Repository: https://github.com/tmustier/pi-for-excel

Applied ideas:

- tool registry as the single tool catalog;
- workbook metadata/selection context;
- per-workbook serialization of mutations;
- recovery checkpoints and revert;
- sessions, compaction, provider abstraction and future MCP boundary.

Difference: automatic context is bounded by our progressive-disclosure and privacy policy; writes additionally require a visible ChangeSet approval flow.

## MS Excel AI Plugin

Repository: https://github.com/cmarathe1/MS-Excel-AI-plugin

Applied ideas:

- previewable and undoable ChangeSets;
- schema validation and post-write verification;
- audit boundary;
- optional sidecar/companion for local models.

Difference: the Windows companion is outside MVP and the production provider path goes through the backend.

## Office Agents

Repository: https://github.com/hewliyang/office-agents/tree/main/packages/excel

Applied ideas:

- isolated Excel package;
- extensible built-in tools;
- agent runtime, sandbox and future skills boundary;
- separate manifests and platform packaging.

Difference: arbitrary Office.js evaluation and shell execution are intentionally excluded from the MVP trust model.

## Claude Sidebar for Excel

Repository: https://github.com/heyimjames/Claude-Sidebar-for-Excel

Applied ideas:

- selection-aware sidebar;
- quick actions and slash-command-style UX;
- attachments as a future UI capability;
- visible cancellation.

Difference: provider keys are not stored in workbook settings in production; they remain on the backend.

## LLMExcel

Repository: https://github.com/liminityab/LLMExcel

Applied ideas:

- standard and streaming AI Custom Functions;
- separate Custom Functions host/runtime.

Difference: custom functions use batching, cache and rate limits and never accept API keys as worksheet arguments.

## Microsoft Excel Labs

Repository: https://github.com/microsoft/Excel-Labs

Applied ideas:

- generative AI functions in the grid;
- dedicated formula-authoring experience;
- multi-step Agent Mode while the user remains in control;
- native, editable Excel outputs.

Excel Labs is treated as an experimental Microsoft reference, not a stable product API contract.
