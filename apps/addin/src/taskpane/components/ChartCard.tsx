import { useEffect, useMemo, useRef, useState } from "react";
import { Chart, registerables, type ChartConfiguration, type Plugin } from "chart.js";
import type { ChartData } from "../../visualization/types.js";
import type { ResponseLanguage } from "../../app/language.js";
import { assertPngBase64, dataUrlToBase64 } from "../../app/image.js";

/**
 * Paints an opaque background behind the chart so exported PNGs / inserted
 * images are readable in any viewer (Chart.js canvases are transparent by
 * default → black in dark photo viewers). Active for the on-screen chart AND
 * the export, so `toBlob` / `toDataURL` capture the same pixels — no export-time
 * mutation of the live chart.
 */
export const backgroundPlugin: Plugin = {
  id: "sheetAgentBackground",
  beforeDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, chart.width, chart.height);
    ctx.restore();
  },
};

Chart.register(...registerables, backgroundPlugin);

export interface ChartInsertDims {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface ChartCardProps {
  readonly data: ChartData;
  readonly language: ResponseLanguage;
  /** Explicit user action — inserts the rendered PNG into the workbook. */
  readonly onInsert?: (base64Png: string, suggestedName: string, dims?: ChartInsertDims) => Promise<void> | void;
}

/** Plot-area height in CSS px. The canvas is sized to (wrapper width × this). */
export const CHART_HEIGHT = 320;
const FALLBACK_WIDTH = 320;
/** Target on-sheet width for an inserted image; height derives from the aspect ratio. */
const INSERT_WIDTH_PX = 640;

// The chart is ALWAYS light-themed: dark text/grid on a white background. That
// keeps the on-screen card, the PNG, and the inserted worksheet image identical
// and readable regardless of the task-pane theme.
const CHART_TEXT = "#1f2430";
const CHART_GRID = "rgba(31,36,48,0.12)";
const CHART_PALETTE = ["#2f6fed", "#e08423", "#2fa66f", "#d24d70", "#8b5cf0", "#2aa5b8", "#c2a52f", "#5b6472"];

function slugify(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\dA-Za-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return ascii.length > 0 ? ascii.slice(0, 60) : "chart";
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Chart configuration. `responsive: false` — the Office WebView does not give
// Chart.js's parent-measurement a reliable box, so ChartCard sizes the canvas
// itself via `chart.resize(width, CHART_HEIGHT)`. `chart.resize` handles
// devicePixelRatio, so PNGs stay crisp.
// ---------------------------------------------------------------------------
export function buildChartConfig(data: ChartData): ChartConfiguration {
  const multiSeries = data.series.kind === "multi-category" || data.series.kind === "multi-xy";
  const plugins = {
    legend: { display: data.type === "pie" || multiSeries, labels: { color: CHART_TEXT } },
    title: { display: true, text: data.title, color: CHART_TEXT },
    tooltip: { enabled: true },
  };
  const baseOptions = { responsive: false as const, maintainAspectRatio: false as const, animation: false as const };
  const cartesianScales = (xTitle?: string, yTitle?: string) => ({
    x: {
      ...(xTitle ? { title: { display: true, text: xTitle, color: CHART_TEXT } } : {}),
      ticks: { color: CHART_TEXT },
      grid: { color: CHART_GRID },
    },
    y: {
      ...(yTitle ? { title: { display: true, text: yTitle, color: CHART_TEXT } } : {}),
      ticks: { color: CHART_TEXT },
      grid: { color: CHART_GRID },
      beginAtZero: true,
    },
  });

  if (data.series.kind === "category") {
    return {
      type: data.type === "pie" ? "pie" : "bar",
      data: {
        labels: [...data.series.labels],
        datasets: [
          {
            label: data.series.valueLabel,
            data: [...data.series.values],
            backgroundColor: data.type === "pie" ? CHART_PALETTE : CHART_PALETTE[0],
            borderColor: data.type === "pie" ? CHART_PALETTE : CHART_PALETTE[0],
          },
        ],
      },
      options: { ...baseOptions, plugins, ...(data.type === "pie" ? {} : { scales: cartesianScales() }) },
    };
  }

  if (data.series.kind === "multi-category") {
    const series = data.series;
    const stacked = series.mode === "stacked";
    const scales = cartesianScales();
    return {
      type: data.type === "line" ? "line" : "bar",
      data: {
        labels: [...series.labels],
        datasets: series.datasets.map((dataset, index) => ({
          label: dataset.label,
          data: dataset.values.map((value) => (value === null ? null : value)),
          backgroundColor: CHART_PALETTE[index % CHART_PALETTE.length],
          borderColor: CHART_PALETTE[index % CHART_PALETTE.length],
          ...(data.type === "line" ? { tension: 0.2, spanGaps: false } : {}),
        })),
      },
      options: {
        ...baseOptions,
        plugins,
        scales: {
          x: { ...scales.x, ...(stacked ? { stacked: true } : {}) },
          y: { ...scales.y, ...(stacked ? { stacked: true } : {}) },
        },
      },
    };
  }

  if (data.series.kind === "multi-xy") {
    const series = data.series;
    return {
      type: "scatter",
      data: {
        datasets: series.datasets.map((dataset, index) => ({
          label: dataset.label,
          data: dataset.points.map(([x, y]) => ({ x: Number(x), y })),
          backgroundColor: CHART_PALETTE[index % CHART_PALETTE.length],
          borderColor: CHART_PALETTE[index % CHART_PALETTE.length],
        })),
      },
      options: { ...baseOptions, plugins, scales: cartesianScales(series.xLabel, series.yLabel) },
    };
  }

  if (data.series.kind === "histogram") {
    const series = data.series;
    const labels = series.counts.map((_, i) => `${round(series.binEdges[i] ?? 0)}–${round(series.binEdges[i + 1] ?? 0)}`);
    return {
      type: "bar",
      data: { labels, datasets: [{ label: series.valueLabel, data: [...series.counts], backgroundColor: CHART_PALETTE[0] }] },
      options: { ...baseOptions, plugins: { ...plugins, legend: { display: false } }, scales: cartesianScales() },
    };
  }

  const points = data.series.points;
  if (data.type === "scatter") {
    return {
      type: "scatter",
      data: {
        datasets: [
          {
            label: `${data.series.xLabel} × ${data.series.yLabel}`,
            data: points.map(([x, y]) => ({ x: Number(x), y })),
            backgroundColor: CHART_PALETTE[0],
          },
        ],
      },
      options: { ...baseOptions, plugins, scales: cartesianScales(data.series.xLabel, data.series.yLabel) },
    };
  }
  return {
    type: "line",
    data: {
      labels: points.map(([x]) => String(x)),
      datasets: [{ label: data.series.yLabel, data: points.map(([, y]) => y), borderColor: CHART_PALETTE[0], backgroundColor: CHART_PALETTE[0], tension: 0.2 }],
    },
    options: { ...baseOptions, plugins, scales: cartesianScales(data.series.xLabel, data.series.yLabel) },
  };
}

function round(value: number): number {
  return Math.abs(value) >= 1 ? Math.round(value * 100) / 100 : Math.round(value * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Optional runtime diagnostics. Enable in the Office WebView console with:
//   localStorage.setItem("sheet-agent-debug-charts", "1")
// then reload. Off by default; no noise in production.
// ---------------------------------------------------------------------------
export function chartDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("sheet-agent-debug-charts") === "1";
  } catch {
    return false;
  }
}

function ancestorReport(canvas: HTMLElement | null): unknown[] {
  const out: unknown[] = [];
  if (typeof getComputedStyle !== "function") return out;
  let el: HTMLElement | null = canvas;
  let hops = 0;
  while (el && hops < 12) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName,
      class: el.className,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      client: { w: el.clientWidth, h: el.clientHeight },
      scroll: { w: el.scrollWidth, h: el.scrollHeight },
      css: {
        display: s.display, position: s.position, width: s.width, height: s.height,
        minHeight: s.minHeight, maxHeight: s.maxHeight,
        overflow: s.overflow, overflowX: s.overflowX, overflowY: s.overflowY,
        flex: `${s.flexGrow} ${s.flexShrink} ${s.flexBasis}`,
        alignItems: s.alignItems, gridTemplateRows: s.gridTemplateRows, contain: s.contain,
      },
    });
    if (el.classList.contains("term-body") || el.classList.contains("term-shell") || el === document.body) break;
    el = el.parentElement;
    hops += 1;
  }
  return out;
}

function logChartDims(phase: string, wrap: HTMLElement | null, canvas: HTMLCanvasElement | null, chart: Chart | null): void {
  if (!chartDebugEnabled()) return;
  const rect = (el: Element | null) => (el ? (({ width, height }) => ({ width: Math.round(width), height: Math.round(height) }))(el.getBoundingClientRect()) : undefined);
  console.info("[SheetAgent chart]", phase, {
    wrapRect: rect(wrap),
    canvasRect: rect(canvas),
    canvasAttr: canvas ? { width: canvas.width, height: canvas.height } : undefined,
    chart: chart ? { width: chart.width, height: chart.height, chartArea: chart.chartArea } : undefined,
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
    ancestors: ancestorReport(canvas),
  });
}

export function ChartCard({ data, language, onInsert }: ChartCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [inserting, setInserting] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const config = useMemo(() => buildChartConfig(data), [data]);
  const fileName = useMemo(() => `sheetagent-${slugify(data.title)}-${today()}.png`, [data.title]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom / no-canvas raster backend: skip real rendering

    logChartDims("mount", wrap, canvas, null);
    chartRef.current?.destroy();
    const chart = new Chart(ctx, config);
    chartRef.current = chart;

    const sizeToWrap = (phase?: string) => {
      const width = Math.round(wrap.getBoundingClientRect().width) || FALLBACK_WIDTH;
      const stale = Math.abs((chart.width ?? 0) - width) > 1 || Math.abs((chart.height ?? 0) - CHART_HEIGHT) > 1;
      if (stale && typeof chart.resize === "function") chart.resize(width, CHART_HEIGHT);
      if (phase) logChartDims(phase, wrap, canvas, chart);
    };

    sizeToWrap("afterCreate");
    const timers: number[] = [];
    const rafs: number[] = [];
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined;
    if (raf) {
      rafs.push(raf(() => {
        sizeToWrap("raf1");
        rafs.push(raf(() => sizeToWrap("raf2")));
      }));
    }
    if (typeof window !== "undefined") timers.push(window.setTimeout(() => sizeToWrap("t100"), 100));

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => sizeToWrap());
      observer.observe(wrap);
    }

    return () => {
      rafs.forEach((id) => typeof cancelAnimationFrame === "function" && cancelAnimationFrame(id));
      timers.forEach((id) => typeof window !== "undefined" && window.clearTimeout(id));
      observer?.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
  }, [config]);

  const t = (ru: string, en: string) => (language === "ru" ? ru : en);

  const savePng = () => {
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.toBlob !== "function") {
      setNote(t("Не удалось создать PNG в этой среде.", "PNG export is not available in this environment."));
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        setNote(t("Пустое изображение.", "The image was empty."));
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }, "image/png");
  };

  const insert = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !onInsert || typeof canvas.toDataURL !== "function") return;
    setInserting(true);
    setNote(null);
    try {
      const base64 = dataUrlToBase64(canvas.toDataURL("image/png"));
      assertPngBase64(base64);
      const aspect = canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : INSERT_WIDTH_PX / CHART_HEIGHT;
      const dims: ChartInsertDims = {
        widthPx: INSERT_WIDTH_PX,
        heightPx: Math.max(180, Math.min(520, Math.round(INSERT_WIDTH_PX / aspect))),
      };
      await onInsert(base64, `SheetAgent — ${data.title}`.slice(0, 100), dims);
      setInserted(true);
    } catch (error) {
      setNote(error instanceof Error ? error.message : t("Не удалось вставить график.", "Could not insert the chart."));
    } finally {
      setInserting(false);
    }
  };

  return (
    <div className="term-chart">
      <div className="term-chart-canvas-wrap" ref={wrapRef}>
        {/* width/height are the pre-resize fallback: if imperative sizing is ever a
            no-op the canvas is still 320px tall (CSS max-width keeps it in the pane). */}
        <canvas ref={canvasRef} width={FALLBACK_WIDTH} height={CHART_HEIGHT} role="img" aria-label={data.title} />
      </div>
      <div className="term-chart-meta">{data.provenance}</div>
      {data.warnings.length > 0 && (
        <ul className="term-chart-warnings">
          {data.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="term-chart-actions">
        <button type="button" className="term-btn" onClick={savePng}>
          {t("Сохранить PNG", "Save PNG")}
        </button>
        {onInsert && (
          <button type="button" className="term-btn" disabled={inserting || inserted} onClick={() => void insert()}>
            {inserted ? t("Вставлено", "Inserted") : inserting ? t("Вставка…", "Inserting…") : t("Вставить в Excel", "Insert into Excel")}
          </button>
        )}
      </div>
      {note && <div className="term-chart-note">{note}</div>}
    </div>
  );
}
