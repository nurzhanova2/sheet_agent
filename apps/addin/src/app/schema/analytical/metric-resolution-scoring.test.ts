// Stage 24.7.1 (final correction) — domain-neutral proof that metric
// resolution precedence is structural, not Balance-specific (§10, §11, §12,
// §13, §16, §30). Candidate sets are hand-built (no schema induction
// needed — `resolveMetric` only consumes label/alias/kind), so these tests
// exercise the resolver in complete isolation from the rest of the pipeline.
import { describe, expect, it } from "vitest";
import {
  MATCH_CLASS_RANK,
  resolveMetric,
  traceMetricResolution,
  type MetricEntry,
  type MetricIndex,
} from "./metric-resolver.js";

function fakeIndex(labels: readonly string[]): MetricIndex {
  const entries: MetricEntry[] = labels.map((label) => ({
    kind: "row_member",
    label,
    aliases: [label.toLowerCase()],
  }));
  return { entries };
}

describe("candidate scoring — no-longest-label heuristic (§7, §13, §16)", () => {
  const idx = fakeIndex(["Активы", "Ликвидные активы", "доля ликвидных активов в активах"]);

  it("an exact normalised match always outranks a containment match, regardless of label length", () => {
    expect(resolveMetric("активы", idx)).toMatchObject({ kind: "resolved", entry: { label: "Активы" } });
  });

  it("the invariant: a strictly stronger match class always wins, never candidate length / substring count / token overlap", () => {
    const t = traceMetricResolution("активы", idx);
    const winner = t.candidates.find((c) => c.label === t.selected)!;
    for (const c of t.candidates) {
      if (c.label === t.selected) continue;
      expect(MATCH_CLASS_RANK[winner.matchClass]).toBeGreaterThan(MATCH_CLASS_RANK[c.matchClass]);
    }
  });
});

describe("generic overlap fixture — Loans / Corporate Loans / Share of Corporate Loans (§11)", () => {
  const idx = fakeIndex(["Loans", "Corporate Loans", "Share of Corporate Loans"]);

  it("'loans' resolves to Loans, not a longer label that merely contains the token", () => {
    expect(resolveMetric("loans", idx)).toMatchObject({ kind: "resolved", entry: { label: "Loans" } });
  });

  it("'corporate loans' resolves to Corporate Loans, not the longest containing label", () => {
    expect(resolveMetric("corporate loans", idx)).toMatchObject({ kind: "resolved", entry: { label: "Corporate Loans" } });
  });

  it("'share of corporate loans' resolves to the full compound label", () => {
    expect(resolveMetric("share of corporate loans", idx)).toMatchObject({ kind: "resolved", entry: { label: "Share of Corporate Loans" } });
  });
});

describe("generic overlap fixture — Revenue / Net Revenue / Revenue Share (§10)", () => {
  const idx = fakeIndex(["Revenue", "Net Revenue", "Revenue Share"]);

  it("'revenue' never resolves to Revenue Share merely because it contains the token", () => {
    expect(resolveMetric("revenue", idx)).toMatchObject({ kind: "resolved", entry: { label: "Revenue" } });
  });

  it("'net revenue' and 'revenue share' resolve to their own exact labels", () => {
    expect(resolveMetric("net revenue", idx)).toMatchObject({ kind: "resolved", entry: { label: "Net Revenue" } });
    expect(resolveMetric("revenue share", idx)).toMatchObject({ kind: "resolved", entry: { label: "Revenue Share" } });
  });
});

describe("ambiguity policy — no strong exact/full-sequence match, several equally plausible candidates (§12)", () => {
  const idx = fakeIndex(["Corporate deposits", "Retail deposits", "Total deposits"]);

  it("'deposits' cannot be deterministically resolved to one canonical metric → ambiguous, never a silent pick", () => {
    const r = resolveMetric("deposits", idx);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(new Set(r.candidates)).toEqual(new Set(["Corporate deposits", "Retail deposits", "Total deposits"]));
    }
  });

  it("the trace reports the same-class ambiguity reason", () => {
    const t = traceMetricResolution("deposits", idx);
    expect(t.selectionReason).toBe("ambiguous_same_class");
    expect(t.selected).toBeUndefined();
    expect(t.candidates.length).toBe(3);
  });

  it("a fully qualified phrase still resolves uniquely despite the ambiguous bare noun", () => {
    expect(resolveMetric("corporate deposits", idx)).toMatchObject({ kind: "resolved", entry: { label: "Corporate deposits" } });
    expect(resolveMetric("total deposits", idx)).toMatchObject({ kind: "resolved", entry: { label: "Total deposits" } });
  });
});

describe("resolver trace shape (§15)", () => {
  it("traceMetricResolution never disagrees with resolveMetric's own selection", () => {
    const idx = fakeIndex(["Активы", "Ликвидные активы", "доля ликвидных активов в активах"]);
    for (const needle of ["активов", "ликвидных активов", "доля ликвидных активов"]) {
      const resolved = resolveMetric(needle, idx);
      const traced = traceMetricResolution(needle, idx);
      if (resolved.kind === "resolved") {
        expect(traced.selected).toBe(resolved.entry.label);
        expect(traced.selectionReason).toBe("higher_match_class");
      }
    }
  });

  it("an unknown needle produces an empty candidate trace", () => {
    const idx = fakeIndex(["Активы", "Ликвидные активы"]);
    const t = traceMetricResolution("совершенно другое слово", idx);
    expect(t.candidates).toEqual([]);
    expect(t.selectionReason).toBe("no_candidates");
  });
});
