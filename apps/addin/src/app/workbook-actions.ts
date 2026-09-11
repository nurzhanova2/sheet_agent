import type { CellValue, ExcelMutationPort } from "@sheet-agent/application";
import { parseLocalRange, translateFormula } from "./a1.js";

export type WorkbookActionType = "set_values" | "set_formulas" | "highlight_range" | "fill_formula";

export interface SetValuesAction {
  readonly id: string;
  readonly type: "set_values";
  readonly sheetName: string;
  readonly range: string;
  readonly description: string;
  readonly payload: { readonly values: readonly (readonly CellValue[])[] };
}
export interface SetFormulasAction {
  readonly id: string;
  readonly type: "set_formulas";
  readonly sheetName: string;
  readonly range: string;
  readonly description: string;
  readonly payload: { readonly formulas: readonly (readonly string[])[] };
}
export interface HighlightAction {
  readonly id: string;
  readonly type: "highlight_range";
  readonly sheetName: string;
  readonly range: string;
  readonly description: string;
  readonly payload: { readonly color: string };
}
export interface FillFormulaAction {
  readonly id: string;
  readonly type: "fill_formula";
  readonly sheetName: string;
  readonly range: string;
  readonly description: string;
  readonly payload: { readonly formula: string; readonly direction: "down" | "right" };
}

export type WorkbookAction = SetValuesAction | SetFormulasAction | HighlightAction | FillFormulaAction;

export const MAX_ACTION_CELLS = 3_000;
export const MAX_FILL_CELLS = 600;
export const MAX_ACTIONS_PER_TURN = 20;

const ACTION_TYPES: readonly WorkbookActionType[] = ["set_values", "set_formulas", "highlight_range", "fill_formula"];
const LOCAL_RANGE = /^[A-Za-z]{1,3}\d{1,7}(:[A-Za-z]{1,3}\d{1,7})?$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const UNSAFE_FORMULA = /\b(?:WEBSERVICE|CALL|REGISTER|RTD|EXEC|DDE|EVALUATE)\s*\(/i;

export interface ParseResult {
  readonly actions: readonly WorkbookAction[];
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCellValue(value: unknown): value is CellValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function rectangular<T>(grid: unknown, guard: (value: unknown) => value is T): readonly (readonly T[])[] | null {
  if (!Array.isArray(grid) || grid.length === 0) return null;
  const width = Array.isArray(grid[0]) ? (grid[0] as unknown[]).length : -1;
  if (width <= 0) return null;
  const rows: T[][] = [];
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== width) return null;
    const typedRow: T[] = [];
    for (const cell of row) {
      if (!guard(cell)) return null;
      typedRow.push(cell);
    }
    rows.push(typedRow);
  }
  return rows;
}

function safeFormula(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("=") && !UNSAFE_FORMULA.test(value);
}

/** Validates a single candidate action. Returns the typed action or an error string. */
export function validateAction(candidate: unknown, index: number): WorkbookAction | string {
  const where = `action #${index + 1}`;
  if (!isRecord(candidate)) return `${where}: not an object`;
  const { type, sheetName, range, description, payload } = candidate;
  if (typeof type !== "string" || !ACTION_TYPES.includes(type as WorkbookActionType)) return `${where}: unknown type "${String(type)}"`;
  if (typeof sheetName !== "string" || sheetName.trim().length === 0) return `${where}: missing sheetName`;
  if (typeof range !== "string" || !LOCAL_RANGE.test(range.replaceAll("$", "").trim())) return `${where}: invalid range "${String(range)}"`;
  if (typeof description !== "string" || description.trim().length === 0) return `${where}: missing description`;
  if (!isRecord(payload)) return `${where}: missing payload`;

  const cleanRange = range.replaceAll("$", "").trim();
  const dims = parseLocalRange(cleanRange);
  const cellCount = dims.rowCount * dims.columnCount;
  const id = `act_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`;
  const base = { id, sheetName: sheetName.trim(), range: cleanRange, description: description.trim() };

  if (type === "set_values") {
    if (cellCount > MAX_ACTION_CELLS) return `${where}: ${cellCount} cells exceeds the ${MAX_ACTION_CELLS}-cell limit`;
    const values = rectangular(payload.values, isCellValue);
    if (!values) return `${where}: payload.values must be a rectangular array of primitive values`;
    if (values.length !== dims.rowCount || (values[0]?.length ?? 0) !== dims.columnCount) return `${where}: values shape ${values.length}x${values[0]?.length ?? 0} does not match range ${dims.rowCount}x${dims.columnCount}`;
    if (values.some((row) => row.some((cell) => typeof cell === "string" && cell.startsWith("=") && UNSAFE_FORMULA.test(cell)))) return `${where}: values contain a disallowed formula`;
    return { ...base, type, payload: { values } };
  }
  if (type === "set_formulas") {
    if (cellCount > MAX_ACTION_CELLS) return `${where}: ${cellCount} cells exceeds the ${MAX_ACTION_CELLS}-cell limit`;
    const formulas = rectangular<string>(payload.formulas, (v): v is string => typeof v === "string");
    if (!formulas) return `${where}: payload.formulas must be a rectangular array of strings`;
    if (formulas.length !== dims.rowCount || (formulas[0]?.length ?? 0) !== dims.columnCount) return `${where}: formulas shape does not match range`;
    if (!formulas.every((row) => row.every(safeFormula))) return `${where}: every formula must start with "=" and use only allowed functions`;
    return { ...base, type, payload: { formulas } };
  }
  if (type === "highlight_range") {
    if (cellCount > MAX_FILL_CELLS) return `${where}: ${cellCount} cells exceeds the ${MAX_FILL_CELLS}-cell highlight limit`;
    const color = payload.color;
    if (typeof color !== "string" || !HEX_COLOR.test(color)) return `${where}: payload.color must be a hex colour like #FFF2CC`;
    return { ...base, type, payload: { color } };
  }
  // fill_formula
  if (cellCount > MAX_ACTION_CELLS) return `${where}: ${cellCount} cells exceeds the ${MAX_ACTION_CELLS}-cell limit`;
  const formula = payload.formula;
  if (!safeFormula(formula)) return `${where}: payload.formula must start with "=" and use only allowed functions`;
  const direction: "down" | "right" = payload.direction === "right" ? "right" : "down";
  return { ...base, type: "fill_formula", payload: { formula, direction } };
}

export function parseActions(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) return { actions: [], errors: ["actions payload must be a JSON array"] };
  if (raw.length > MAX_ACTIONS_PER_TURN) return { actions: [], errors: [`too many actions (${raw.length} > ${MAX_ACTIONS_PER_TURN})`] };
  const actions: WorkbookAction[] = [];
  const errors: string[] = [];
  raw.forEach((candidate, index) => {
    const result = validateAction(candidate, index);
    if (typeof result === "string") errors.push(result);
    else actions.push(result);
  });
  return { actions, errors };
}

export function qualifiedAddress(action: WorkbookAction): string {
  return `${action.sheetName}!${action.range}`;
}

export function expandFillFormula(action: FillFormulaAction): string[][] {
  const dims = parseLocalRange(action.range);
  const grid: string[][] = [];
  for (let row = 0; row < dims.rowCount; row += 1) {
    const line: string[] = [];
    for (let column = 0; column < dims.columnCount; column += 1) {
      const rowDelta = action.payload.direction === "down" ? row : 0;
      const columnDelta = action.payload.direction === "right" ? column : 0;
      line.push(translateFormula(action.payload.formula, rowDelta, columnDelta));
    }
    grid.push(line);
  }
  return grid;
}

export function previewLines(action: WorkbookAction): string[] {
  const target = qualifiedAddress(action);
  switch (action.type) {
    case "set_values":
      return [`Set values in ${target}`, `${action.payload.values.length} row(s) x ${action.payload.values[0]?.length ?? 0} column(s)`];
    case "set_formulas":
      return [`Set formulas in ${target}`, ...action.payload.formulas.slice(0, 3).map((row) => row.join("  |  "))];
    case "highlight_range":
      return [`Highlight ${target}`, `Fill colour ${action.payload.color}`];
    case "fill_formula":
      return [`Fill ${action.payload.direction} ${action.payload.formula} across ${target}`];
  }
}

// --- apply / undo ---------------------------------------------------------------

interface CellSnapshot {
  readonly kind: "cells";
  readonly formulas: readonly (readonly (string | CellValue)[])[];
  readonly numberFormats: readonly (readonly string[])[];
}
interface FillSnapshot {
  readonly kind: "fill";
  readonly colors: readonly (readonly string[])[];
}
type ActionSnapshot = CellSnapshot | FillSnapshot;

export interface AppliedChange {
  readonly id: string;
  readonly action: WorkbookAction;
  readonly snapshot: ActionSnapshot;
  readonly appliedAt: number;
}

export interface RangeReader {
  readRange(address: string): Promise<{
    readonly formulas: readonly (readonly (string | CellValue)[])[];
    readonly numberFormats: readonly (readonly string[])[];
  }>;
}

/** Captures enough previous state to fully undo the action, then applies it. */
export async function applyAction(
  port: ExcelMutationPort & RangeReader,
  action: WorkbookAction,
): Promise<AppliedChange> {
  const address = qualifiedAddress(action);
  let snapshot: ActionSnapshot;
  if (action.type === "highlight_range") {
    snapshot = { kind: "fill", colors: await port.readFillColors(address) };
    await port.writeFillColors(address, gridOf(action.payload.color, action.range));
  } else {
    const before = await port.readRange(address);
    snapshot = { kind: "cells", formulas: before.formulas, numberFormats: before.numberFormats };
    if (action.type === "set_values") await port.writeRange(address, { values: action.payload.values });
    else if (action.type === "set_formulas") await port.writeRange(address, { formulas: action.payload.formulas });
    else await port.writeRange(address, { formulas: expandFillFormula(action) });
  }
  return { id: action.id, action, snapshot, appliedAt: Date.now() };
}

export async function undoChange(port: ExcelMutationPort, change: AppliedChange): Promise<void> {
  const address = qualifiedAddress(change.action);
  if (change.snapshot.kind === "fill") {
    await port.writeFillColors(address, change.snapshot.colors);
  } else {
    await port.writeRange(address, {
      formulas: change.snapshot.formulas,
      numberFormats: change.snapshot.numberFormats,
    });
  }
}

function gridOf(color: string, range: string): string[][] {
  const dims = parseLocalRange(range);
  return Array.from({ length: dims.rowCount }, () => Array.from({ length: dims.columnCount }, () => color));
}
