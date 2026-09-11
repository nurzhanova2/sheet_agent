import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { backgroundPlugin, buildChartConfig, ChartCard, CHART_HEIGHT } from "./ChartCard.js";
import type { ChartData } from "../../visualization/types.js";

// Chart.js needs a real 2D raster context which jsdom lacks. Mock it (vi.mock is
// hoisted above the import) so we can assert ChartCard's imperative sizing.
interface FakeChart {
  resize: Mock;
  destroy: Mock;
  width: number;
  height: number;
  chartArea: Record<string, number>;
}
const { chartInstances, ChartMock } = vi.hoisted(() => {
  const instances: FakeChart[] = [];
  const mock = vi.fn(() => {
    const inst: FakeChart = { resize: vi.fn(), destroy: vi.fn(), width: 0, height: 0, chartArea: {} };
    instances.push(inst);
    return inst;
  }) as unknown as Mock & { register: Mock };
  mock.register = vi.fn();
  return { chartInstances: instances, ChartMock: mock };
});
vi.mock("chart.js", () => ({ Chart: ChartMock, registerables: [] }));

const CATEGORY: ChartData = {
  type: "bar",
  title: "Средний Fact по Region",
  series: { kind: "category", labels: ["Aktobe", "Almaty"], values: [263.5, 240.1], valueLabel: "mean(Fact)" },
  provenance: "Sales Test Data!A1:L121 · 120 data rows",
  rowsAnalyzed: 120,
  truncated: false,
  warnings: ["2 smaller categories were combined into \"Другое\"."],
};

const SCATTER: ChartData = {
  type: "scatter",
  title: "Plan vs Fact",
  series: { kind: "xy", points: [[100, 90], [200, 260]], xLabel: "Plan", yLabel: "Fact", xIsDate: false },
  provenance: "Sales Test Data!A1:L121 · 120 data rows",
  rowsAnalyzed: 120,
  truncated: false,
  warnings: [],
};

const GROUPED_BAR: ChartData = {
  type: "bar",
  title: "Средние Plan и Fact по Category",
  series: {
    kind: "multi-category",
    labels: ["Accessories", "Electronics", "Furniture"],
    mode: "grouped",
    xIsDate: false,
    datasets: [
      { id: "plan", label: "Average Plan", values: [227.125, 222.945946, 199.942857], pointCount: 3, sourceColumns: ["Plan"], aggregate: "mean" },
      { id: "fact", label: "Average Fact", values: [228.3125, 226, 205.285714], pointCount: 3, sourceColumns: ["Fact"], aggregate: "mean" },
    ],
  },
  provenance: "Sales Test Data!A1:L121 · 120 data rows",
  rowsAnalyzed: 120,
  truncated: false,
  warnings: [],
};

const GROUPED_SCATTER: ChartData = {
  type: "scatter",
  title: "Plan vs Fact по Category",
  series: {
    kind: "multi-xy",
    xLabel: "Plan",
    yLabel: "Fact",
    groupByColumn: "Category",
    totalPointCount: 5,
    datasets: [
      { id: "g1", label: "Accessories", group: "Accessories", points: [[127, 93], [349, 268]], pointCount: 2 },
      { id: "g2", label: "Electronics", group: "Electronics", points: [[328, 350], [299, 317], [346, 440]], pointCount: 3 },
    ],
  },
  provenance: "Sales Test Data!A1:L121 · 120 data rows",
  rowsAnalyzed: 120,
  truncated: false,
  warnings: [],
};

const HISTOGRAM: ChartData = {
  type: "histogram",
  title: "Variance % distribution",
  series: { kind: "histogram", binEdges: [-0.3, 0, 0.3, 0.6], counts: [40, 50, 30], valueLabel: "Variance %" },
  provenance: "Sales Test Data!A1:L121 · 120 data rows",
  rowsAnalyzed: 120,
  truncated: false,
  warnings: [],
};

describe("buildChartConfig", () => {
  it("maps chart types and passes deterministic data straight through", () => {
    expect(buildChartConfig(CATEGORY).type).toBe("bar");
    expect(buildChartConfig({ ...CATEGORY, type: "pie" }).type).toBe("pie");
    expect(buildChartConfig(SCATTER).type).toBe("scatter");
    expect(buildChartConfig(HISTOGRAM).type).toBe("bar");

    const bar = buildChartConfig(CATEGORY);
    expect(bar.data.labels).toEqual(["Aktobe", "Almaty"]);
    expect(bar.data.datasets[0]?.data).toEqual([263.5, 240.1]);

    const scatter = buildChartConfig(SCATTER);
    // canonical scatter form: {x:number, y:number}
    expect(scatter.data.datasets[0]?.data).toEqual([{ x: 100, y: 90 }, { x: 200, y: 260 }]);

    const hist = buildChartConfig(HISTOGRAM);
    expect(hist.data.labels).toEqual(["-0.3–0", "0–0.3", "0.3–0.6"]);
    expect(hist.data.datasets[0]?.data).toEqual([40, 50, 30]);
  });

  it("maps a grouped bar to two real Chart.js datasets with deterministic values", () => {
    const config = buildChartConfig(GROUPED_BAR);
    expect(config.type).toBe("bar");
    expect(config.data.labels).toEqual(["Accessories", "Electronics", "Furniture"]);
    expect(config.data.datasets).toHaveLength(2);
    expect(config.data.datasets[0]?.label).toBe("Average Plan");
    expect(config.data.datasets[0]?.data).toEqual([227.125, 222.945946, 199.942857]);
    expect(config.data.datasets[1]?.data).toEqual([228.3125, 226, 205.285714]);
    // grouped (not stacked) → no stacked flag on the axes
    const scales = (config.options as { scales?: { x?: { stacked?: boolean }; y?: { stacked?: boolean } } }).scales;
    expect(scales?.x?.stacked).toBeUndefined();
    // multi-series legend is on
    expect((config.options as { plugins?: { legend?: { display?: boolean } } }).plugins?.legend?.display).toBe(true);
  });

  it("stacked mode sets the stacked flag on both axes", () => {
    const config = buildChartConfig({ ...GROUPED_BAR, series: { ...GROUPED_BAR.series, mode: "stacked" } as typeof GROUPED_BAR.series });
    const scales = (config.options as { scales?: { x?: { stacked?: boolean }; y?: { stacked?: boolean } } }).scales;
    expect(scales?.x?.stacked).toBe(true);
    expect(scales?.y?.stacked).toBe(true);
  });

  it("maps a grouped scatter to one Chart.js dataset per group", () => {
    const config = buildChartConfig(GROUPED_SCATTER);
    expect(config.type).toBe("scatter");
    expect(config.data.datasets).toHaveLength(2);
    expect(config.data.datasets[0]?.label).toBe("Accessories");
    expect(config.data.datasets[0]?.data).toEqual([{ x: 127, y: 93 }, { x: 349, y: 268 }]);
    expect(config.data.datasets[1]?.data).toHaveLength(3);
  });

  it("uses responsive:false (ChartCard sizes the canvas itself) with x/y scales present", () => {
    for (const data of [CATEGORY, SCATTER, HISTOGRAM, { ...SCATTER, type: "line" as const }]) {
      const options = buildChartConfig(data).options as {
        responsive?: boolean;
        maintainAspectRatio?: boolean;
        scales?: { x?: unknown; y?: unknown };
      };
      expect(options.responsive).toBe(false);
      expect(options.maintainAspectRatio).toBe(false);
      expect(options.scales?.x).toBeDefined();
      expect(options.scales?.y).toBeDefined();
    }
    // pie has no cartesian scales
    expect((buildChartConfig({ ...CATEGORY, type: "pie" }).options as { scales?: unknown }).scales).toBeUndefined();
  });

  it("always uses a dark, theme-independent text colour (readable on the white export background)", () => {
    document.documentElement.dataset["theme"] = "dark";
    try {
      const opts = buildChartConfig(SCATTER).options as {
        plugins?: { title?: { color?: string } };
        scales?: { x?: { ticks?: { color?: string } } };
      };
      expect(opts.plugins?.title?.color).toBe("#1f2430");
      expect(opts.scales?.x?.ticks?.color).toBe("#1f2430");
    } finally {
      delete document.documentElement.dataset["theme"];
    }
  });

  it("ships an opaque-background plugin so exported PNGs are not transparent", () => {
    expect(backgroundPlugin.id).toBe("sheetAgentBackground");
    // it paints white with destination-over so the chart pixels stay on top
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      save: () => calls.push(["save", undefined]),
      restore: () => calls.push(["restore", undefined]),
      fillRect: (...a: unknown[]) => calls.push(["fillRect", a]),
      set globalCompositeOperation(v: string) { calls.push(["gco", v]); },
      set fillStyle(v: string) { calls.push(["fillStyle", v]); },
    };
    const beforeDraw = backgroundPlugin.beforeDraw as unknown as (chart: { ctx: unknown; width: number; height: number }) => void;
    beforeDraw({ ctx, width: 600, height: 320 });
    expect(calls).toContainEqual(["gco", "destination-over"]);
    expect(calls).toContainEqual(["fillStyle", "#ffffff"]);
    expect(calls).toContainEqual(["fillRect", [0, 0, 600, 320]]);
  });
});

describe("ChartCard", () => {
  const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let created: string[];

  beforeEach(() => {
    created = [];
    chartInstances.length = 0;
    ChartMock.mockClear();
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() });
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback, type?: string) {
      created.push(String(type));
      cb(new Blob([PNG_MAGIC], { type: type ?? "image/png" }));
    } as typeof HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,iVBORw0KGgo=") as typeof HTMLCanvasElement.prototype.toDataURL;
  });

  afterEach(() => vi.unstubAllGlobals());

  function withCanvasContext() {
    // Give the canvas a truthy 2D context so ChartCard's render effect runs.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
  function withoutCanvasContext() {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }

  it("renders provenance, warnings and a canvas inside a definite-height wrapper", () => {
    withoutCanvasContext();
    const { container } = render(<ChartCard data={CATEGORY} language="ru" />);
    expect(screen.getByText(/Sales Test Data!A1:L121 · 120 data rows/)).toBeInTheDocument();
    expect(screen.getByText(/Другое/)).toBeInTheDocument();
    const canvas = screen.getByRole("img", { name: "Средний Fact по Region" });
    expect(canvas.parentElement).toHaveClass("term-chart-canvas-wrap");
    expect(container.querySelector(".term-chart-canvas-wrap")).not.toBeNull();
  });

  it("sizes the canvas imperatively to (wrapper width × CHART_HEIGHT) and observes the wrapper for resizes", () => {
    withCanvasContext();
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeRO {
      constructor(readonly cb: ResizeObserverCallback) {}
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", FakeRO as unknown as typeof ResizeObserver);
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 480, height: CHART_HEIGHT, top: 0, left: 0, right: 480, bottom: CHART_HEIGHT, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    const { unmount } = render(<ChartCard data={SCATTER} language="en" />);

    expect(ChartMock).toHaveBeenCalledTimes(1);
    const chart = chartInstances[0]!;
    expect(chart.resize).toHaveBeenCalledWith(480, CHART_HEIGHT);
    expect(observe).toHaveBeenCalledTimes(1);

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(chart.destroy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a minimum width when the wrapper measures 0 (WebView not laid out yet)", () => {
    withCanvasContext();
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    render(<ChartCard data={SCATTER} language="en" />);
    const chart = chartInstances[0]!;
    expect(chart.resize).toHaveBeenCalledWith(320, CHART_HEIGHT); // FALLBACK_WIDTH
  });

  it("Save PNG produces an image/png blob with a valid PNG signature and a deterministic filename", async () => {
    withoutCanvasContext();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "a") {
        Object.defineProperty(el, "href", { set(value: string) { void value; }, get() { return "blob:mock"; } });
      }
      return el;
    });

    render(<ChartCard data={SCATTER} language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Save PNG" }));
    await Promise.resolve();

    expect(created).toContain("image/png");
    const anchor = (document.createElement as unknown as { mock: { results: { value: HTMLElement }[] } }).mock.results
      .map((r) => r.value)
      .find((el): el is HTMLAnchorElement => el.tagName === "A");
    expect(anchor?.download).toMatch(/^sheetagent-plan-vs-fact-\d{8}\.png$/);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("Insert into Excel passes raw base64 + aspect-preserving dimensions, only on explicit click", async () => {
    withoutCanvasContext();
    const onInsert = vi.fn<(base64: string, name: string, dims?: { widthPx: number; heightPx: number }) => Promise<void>>(async () => undefined);
    render(<ChartCard data={SCATTER} language="en" onInsert={onInsert} />);
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Insert into Excel" }));
    await vi.waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1));
    const [base64, name, dims] = onInsert.mock.calls[0]!;
    expect(base64).toBe("iVBORw0KGgo="); // data-URL prefix stripped
    expect(name).toContain("Plan vs Fact");
    expect(dims?.widthPx).toBe(640);
    expect(dims && dims.heightPx).toBeGreaterThan(0);
    expect(dims && dims.heightPx).toBeLessThanOrEqual(520);
  });

  it("Insert into Excel refuses a non-PNG image and shows an error instead of calling the handler", async () => {
    withoutCanvasContext();
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/jpeg;base64,/9j/4AAQSkZJRg") as typeof HTMLCanvasElement.prototype.toDataURL;
    const onInsert = vi.fn(async () => undefined);
    render(<ChartCard data={SCATTER} language="en" onInsert={onInsert} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert into Excel" }));
    await vi.waitFor(() => expect(screen.getByText(/not a PNG/i)).toBeInTheDocument());
    expect(onInsert).not.toHaveBeenCalled();
  });
});
