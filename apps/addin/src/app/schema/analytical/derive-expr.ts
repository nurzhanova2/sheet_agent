// ---------------------------------------------------------------------------
// Stage 26.2 §4/§30 — the restricted derived-expression AST.
//
// Extracted verbatim from the Stage 25 tool registry so both engines evaluate
// a model-supplied expression through ONE implementation (§4). The contract is
// the point: a closed set of typed nodes, no code strings, no `eval`, no
// property access, and a division guard — the model can describe arithmetic
// over a result's own numeric fields and nothing else.
// ---------------------------------------------------------------------------

export type ExprNode =
  | { readonly field: string }
  | { readonly const: number }
  | { readonly op: "add" | "subtract" | "multiply" | "divide"; readonly left: ExprNode; readonly right: ExprNode }
  | { readonly op: "abs" | "neg"; readonly value: ExprNode };

/** Structural validation — an unknown key or extra property fails closed. */
export function isValidExpr(node: unknown): node is ExprNode {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const n = node as Record<string, unknown>;
  if (typeof n["field"] === "string" && Object.keys(n).length === 1) return true;
  if (typeof n["const"] === "number" && Object.keys(n).length === 1) return true;
  if ((n["op"] === "add" || n["op"] === "subtract" || n["op"] === "multiply" || n["op"] === "divide") && Object.keys(n).length === 3) {
    return isValidExpr(n["left"]) && isValidExpr(n["right"]);
  }
  if ((n["op"] === "abs" || n["op"] === "neg") && Object.keys(n).length === 2) return isValidExpr(n["value"]);
  return false;
}

/** Evaluates against one row's numeric fields. `null` propagates (missing field, division by ~0). */
export function evalExpr(node: ExprNode, row: Readonly<Record<string, number>>): number | null {
  if ("field" in node) {
    const v = row[node.field];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  if ("const" in node) return node.const;
  if ("value" in node) {
    const v = evalExpr(node.value, row);
    if (v === null) return null;
    return node.op === "abs" ? Math.abs(v) : -v;
  }
  const l = evalExpr(node.left, row);
  const r = evalExpr(node.right, row);
  if (l === null || r === null) return null;
  switch (node.op) {
    case "add":
      return l + r;
    case "subtract":
      return l - r;
    case "multiply":
      return l * r;
    case "divide":
      return Math.abs(r) < 1e-12 ? null : l / r;
  }
}

/** Every field name an expression reads — used to validate it against a result's schema. */
export function exprFields(node: ExprNode, into: Set<string> = new Set()): ReadonlySet<string> {
  if ("field" in node) into.add(node.field);
  else if ("value" in node) exprFields(node.value, into);
  else if ("left" in node) {
    exprFields(node.left, into);
    exprFields(node.right, into);
  }
  return into;
}
