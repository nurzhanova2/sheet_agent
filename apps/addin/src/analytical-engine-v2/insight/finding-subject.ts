import type { AnalysisGrids } from "../../app/schema/matrix-analysis.js";
import type { TableSchema } from "../../app/schema/schema-induction.js";
import { AXIS_NOUN_RE, DIMENSION_NOUN_RE, buildMetricIndex } from "../../app/schema/analytical/metric-resolver.js";
import type { VerifiedFinding } from "./verified-finding.js";

export type SubjectScope = "entity" | "metric" | "period" | "table" | "group" | "comparison";

export interface PeriodRange {
  readonly start: string;
  readonly end: string;
}

export interface FindingSubject {
  readonly entityId?: string;
  readonly entityLabel?: string;
  readonly metric?: string;
  readonly period?: string;
  readonly periodRange?: PeriodRange;
  readonly members?: readonly string[];
  readonly candidates?: readonly string[];
  readonly scope: SubjectScope;
}

export type HoldReason =
  | "ENTITY_SUBJECT_REQUIRED"
  | "METRIC_SUBJECT_REQUIRED"
  | "PERIOD_SUBJECT_REQUIRED"
  | "GROUP_SUBJECT_REQUIRED"
  | "GENERIC_SUBJECT_LABEL"
  | "POSITIONAL_SUBJECT_LABEL"
  | "SUBJECT_AMBIGUOUS";

const GENERIC_SUBJECT =
  /^(?:показател[ьия]|продукт[аы]?|позици[яи]|значени[ея]|метрик[аи]|строк[аи]|элемент[аы]?|объект[аы]?|запис[ьи]|данны[ех]|item|items|value|values|metric|metrics|product|products|row|rows|entity|entities|record|records|element|object)$/iu;

const POSITIONAL_SUBJECT =
  /^(?:-?\d+(?:[.,]\d+)?|[a-z]\d{1,3}|(?:row|col|column|строк[аи]|столбец)\s*\d+|result_\d+|finding_\d+|out\d+)$/iu;

export type SubjectAxisKind = "entity" | "metric" | "none";

export interface EntityAxis {
  readonly kind: SubjectAxisKind;
  readonly labels: readonly string[];
  readonly normalized: ReadonlySet<string>;
}

export const NO_ENTITY_AXIS: EntityAxis = { kind: "none", labels: [], normalized: new Set<string>() };

export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[«»"'`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function axisHeaderText(schema: TableSchema, grids: AnalysisGrids): string {
  const row = schema.headerRows[schema.headerRows.length - 1];
  const col = schema.rowHeaderColumns[schema.rowHeaderColumns.length - 1];
  if (row === undefined || col === undefined) return "";
  const cell = grids.values[row]?.[col];
  return cell === null || cell === undefined ? "" : String(cell).trim();
}

function axisKindOf(schema: TableSchema, grids: AnalysisGrids | undefined): SubjectAxisKind {
  if (schema.orientation === "column_metrics") return "metric";
  const header = grids ? axisHeaderText(schema, grids) : "";
  if (header === "") return "metric";
  const tokens = header.split(/[\s/\\,.()-]+/u).filter((t) => t !== "");
  if (tokens.some((t) => DIMENSION_NOUN_RE.test(t))) return "entity";
  if (tokens.some((t) => AXIS_NOUN_RE.test(t))) return "metric";
  return "entity";
}

export function entityAxisFromLabels(labels: readonly string[], kind: SubjectAxisKind): EntityAxis {
  const clean = labels.map((l) => l.trim()).filter((l) => l !== "");
  if (clean.length === 0) return NO_ENTITY_AXIS;
  return { kind, labels: clean, normalized: new Set(clean.map(normalizeLabel)) };
}

export function entityAxisOf(schema: TableSchema | undefined, grids?: AnalysisGrids): EntityAxis {
  if (!schema) return NO_ENTITY_AXIS;
  return entityAxisFromLabels(
    buildMetricIndex(schema).entries.map((e) => e.label),
    axisKindOf(schema, grids),
  );
}

export interface GroundingContext {
  readonly axis: EntityAxis;
  readonly hasPeriodAxis: boolean;
}

export function groundingContextOf(schema: TableSchema | undefined, grids?: AnalysisGrids): GroundingContext {
  return { axis: entityAxisOf(schema, grids), hasPeriodAxis: schema?.temporalAxis !== undefined };
}

export function isAxisMember(label: string | undefined, axis: EntityAxis): boolean {
  if (label === undefined) return false;
  return axis.normalized.has(normalizeLabel(label));
}

export function isReadableLabel(raw: string | undefined, axis: EntityAxis = NO_ENTITY_AXIS): boolean {
  const label = (raw ?? "").trim();
  if (label === "") return false;
  if (isAxisMember(label, axis)) return true;
  if (GENERIC_SUBJECT.test(label)) return false;
  if (POSITIONAL_SUBJECT.test(label)) return false;
  return true;
}

function labelProblem(raw: string | undefined, axis: EntityAxis): HoldReason | null {
  const label = (raw ?? "").trim();
  if (label === "" || isAxisMember(label, axis)) return null;
  if (POSITIONAL_SUBJECT.test(label)) return "POSITIONAL_SUBJECT_LABEL";
  if (GENERIC_SUBJECT.test(label)) return "GENERIC_SUBJECT_LABEL";
  return null;
}

function namesItself(subject: FindingSubject, axis: EntityAxis): boolean {
  return isReadableLabel(subject.entityLabel, axis) || isReadableLabel(subject.metric, axis);
}

export function groundingOf(subject: FindingSubject | undefined, context: GroundingContext): readonly HoldReason[] {
  const { axis } = context;
  if (!subject) return axis.kind === "none" ? [] : ["ENTITY_SUBJECT_REQUIRED"];
  if (subject.candidates && subject.candidates.length > 1) return ["SUBJECT_AMBIGUOUS"];

  const problems: HoldReason[] = [];
  const entityProblem = labelProblem(subject.entityLabel, axis);
  const metricProblem = labelProblem(subject.metric, axis);

  if (subject.scope === "entity") {
    if (entityProblem) problems.push(entityProblem);
    else if (!isReadableLabel(subject.entityLabel, axis) && axis.kind !== "none") problems.push("ENTITY_SUBJECT_REQUIRED");
  }

  if (subject.scope === "metric") {
    if (metricProblem) problems.push(metricProblem);
    else if (!isReadableLabel(subject.metric, axis)) problems.push("METRIC_SUBJECT_REQUIRED");
  }

  if (subject.scope === "group") {
    const named = namesItself(subject, axis);
    const enumerated = (subject.members ?? []).some((m) => isReadableLabel(m, axis));
    if (entityProblem && !enumerated) problems.push(entityProblem);
    else if (!named && !enumerated && axis.kind !== "none") problems.push("GROUP_SUBJECT_REQUIRED");
  }

  if (subject.scope === "comparison") {
    const sides = [subject.entityLabel, subject.metric, ...(subject.members ?? [])].filter((s) => isReadableLabel(s, axis));
    if (sides.length < 2 && axis.kind !== "none") problems.push("ENTITY_SUBJECT_REQUIRED");
  }

  if (subject.scope === "period" && context.hasPeriodAxis && subject.period === undefined && subject.periodRange === undefined) {
    problems.push("PERIOD_SUBJECT_REQUIRED");
  }

  return problems;
}

export function subjectLabel(subject: FindingSubject | undefined, fallback = ""): string {
  if (!subject) return fallback;
  const parts: string[] = [];
  const entity = (subject.entityLabel ?? "").trim();
  const metric = (subject.metric ?? "").trim();
  if (isReadableLabel(entity)) parts.push(entity);
  if (isReadableLabel(metric) && metric !== entity) parts.push(metric);
  if (parts.length === 0 && subject.members && subject.members.length > 0) parts.push(subject.members.slice(0, 3).join(", "));
  if (parts.length === 0) return fallback;
  const head = parts.join(", ");
  const when = subject.period ?? (subject.periodRange ? `${subject.periodRange.start}–${subject.periodRange.end}` : undefined);
  return when ? `${head} (${when})` : head;
}

export function subjectNames(subject: FindingSubject | undefined): readonly string[] {
  if (!subject) return [];
  return [subject.entityLabel, subject.metric, ...(subject.members ?? [])].filter((s): s is string => isReadableLabel(s));
}

export interface HeldFinding {
  readonly finding: VerifiedFinding;
  readonly reason: HoldReason;
  readonly reasons: readonly HoldReason[];
}

export interface GroundedFindings {
  readonly visible: readonly VerifiedFinding[];
  readonly held: readonly HeldFinding[];
}

export function groundFindings(findings: readonly VerifiedFinding[], context: GroundingContext): GroundedFindings {
  const visible: VerifiedFinding[] = [];
  const held: HeldFinding[] = [];
  for (const finding of findings) {
    const reasons = groundingOf(finding.subjectRef, context);
    if (reasons.length === 0) visible.push(finding);
    else held.push({ finding, reason: reasons[0]!, reasons });
  }
  return { visible, held };
}

const UNNAMED_SUBJECT_HOLDS: ReadonlySet<HoldReason> = new Set<HoldReason>([
  "ENTITY_SUBJECT_REQUIRED",
  "GROUP_SUBJECT_REQUIRED",
  "GENERIC_SUBJECT_LABEL",
  "POSITIONAL_SUBJECT_LABEL",
  "SUBJECT_AMBIGUOUS",
]);

export interface GroundingStats {
  readonly extractedFindings: number;
  readonly visibleGroundedFindings: number;
  readonly heldFindings: number;
  readonly unnamedSubjectFindingsHeld: number;
  readonly heldByFindingType: Readonly<Record<string, number>>;
  readonly heldByReason: Readonly<Record<string, number>>;
}

export function groundingStats(grounded: GroundedFindings): GroundingStats {
  const heldByFindingType: Record<string, number> = {};
  const heldByReason: Record<string, number> = {};
  let unnamed = 0;
  for (const entry of grounded.held) {
    heldByFindingType[entry.finding.findingType] = (heldByFindingType[entry.finding.findingType] ?? 0) + 1;
    heldByReason[entry.reason] = (heldByReason[entry.reason] ?? 0) + 1;
    if (entry.reasons.some((r) => UNNAMED_SUBJECT_HOLDS.has(r))) unnamed += 1;
  }
  return {
    extractedFindings: grounded.visible.length + grounded.held.length,
    visibleGroundedFindings: grounded.visible.length,
    heldFindings: grounded.held.length,
    unnamedSubjectFindingsHeld: unnamed,
    heldByFindingType,
    heldByReason,
  };
}

const HOLD_RU: Record<HoldReason, string> = {
  ENTITY_SUBJECT_REQUIRED: "не указано, о каком объекте таблицы речь",
  METRIC_SUBJECT_REQUIRED: "не указано, о каком показателе речь",
  PERIOD_SUBJECT_REQUIRED: "не указан период",
  GROUP_SUBJECT_REQUIRED: "не указано, из чего состоит группа",
  GENERIC_SUBJECT_LABEL: "вместо названия стоит общее слово",
  POSITIONAL_SUBJECT_LABEL: "вместо названия стоит номер или позиция",
  SUBJECT_AMBIGUOUS: "подходит несколько объектов, и выбрать нельзя",
};

const HOLD_EN: Record<HoldReason, string> = {
  ENTITY_SUBJECT_REQUIRED: "does not say which entity of the table it is about",
  METRIC_SUBJECT_REQUIRED: "does not say which metric it is about",
  PERIOD_SUBJECT_REQUIRED: "does not say which period",
  GROUP_SUBJECT_REQUIRED: "does not say what the group consists of",
  GENERIC_SUBJECT_LABEL: "carries a common noun where a name belongs",
  POSITIONAL_SUBJECT_LABEL: "carries a position or a handle where a name belongs",
  SUBJECT_AMBIGUOUS: "several entities match and none can be chosen",
};

export function holdReasonText(reason: HoldReason, locale: "ru" | "en"): string {
  return locale === "ru" ? HOLD_RU[reason] : HOLD_EN[reason];
}

export interface SubjectEvidence {
  readonly scope: SubjectScope;
  readonly entityId?: string;
  readonly label?: string;
  readonly metric?: string;
  readonly period?: string;
  readonly periodRange?: PeriodRange;
  readonly members?: readonly string[];
  readonly candidates?: readonly string[];
  readonly axis?: EntityAxis;
}

export function buildFindingSubject(evidence: SubjectEvidence): FindingSubject | null {
  const axis = evidence.axis ?? NO_ENTITY_AXIS;
  const label = (evidence.label ?? "").trim();
  const metric = (evidence.metric ?? "").trim();
  const members = (evidence.members ?? []).map((m) => m.trim()).filter((m) => m !== "");
  const candidates = (evidence.candidates ?? []).map((c) => c.trim()).filter((c) => c !== "");
  const period = (evidence.period ?? "").trim();

  const scope: SubjectScope = evidence.scope === "entity" && axis.kind === "metric" ? "metric" : evidence.scope;
  const named = scope === "metric" && metric === "" ? label : metric;

  const subject: FindingSubject = {
    scope,
    ...(evidence.entityId !== undefined ? { entityId: evidence.entityId } : {}),
    ...(scope !== "metric" && label !== "" ? { entityLabel: label } : {}),
    ...(named !== "" ? { metric: named } : {}),
    ...(period !== "" ? { period } : {}),
    ...(evidence.periodRange && evidence.periodRange.start !== "" && evidence.periodRange.end !== "" ? { periodRange: evidence.periodRange } : {}),
    ...(members.length > 0 ? { members } : {}),
    ...(candidates.length > 1 ? { candidates } : {}),
  };

  const empty =
    subject.entityLabel === undefined &&
    subject.metric === undefined &&
    subject.period === undefined &&
    subject.periodRange === undefined &&
    subject.members === undefined &&
    subject.candidates === undefined;
  if (empty && scope !== "table") return null;
  return subject;
}
