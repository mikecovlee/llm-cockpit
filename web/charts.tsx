import * as echarts from "echarts";
import * as React from "react";
import { t } from "./i18n.ts";
import type { Theme } from "./prefs.ts";
import { useUI } from "./shared.tsx";

export interface ChartPalette {
  axis: string;
  grid: string;
  split: string;
  legend: string;
  blue: string;
  green: string;
  amber: string;
  red: string;
  violet: string;
  orange: string;
  pink: string;
  blueLight: string;
  teal: string;
}

export const CHART: Record<Theme, ChartPalette> = {
  dark: {
    axis: "#6e7681",
    grid: "#21262d",
    split: "#1c2128",
    legend: "#8b949e",
    blue: "#38bdf8",
    green: "#34d399",
    amber: "#fbbf24",
    red: "#f87171",
    violet: "#a78bfa",
    orange: "#fb923c",
    pink: "#f472b6",
    blueLight: "#60a5fa",
    teal: "#2dd4bf",
  },
  light: {
    axis: "#57606a",
    grid: "#d0d7de",
    split: "#e6ebf1",
    legend: "#57606a",
    blue: "#0284c7",
    green: "#059669",
    amber: "#d97706",
    red: "#dc2626",
    violet: "#7c3aed",
    orange: "#ea580c",
    pink: "#db2777",
    blueLight: "#2563eb",
    teal: "#0d9488",
  },
};

export interface Series {
  name: string;
  data: (number | null)[];
  color: string;
}

export function LineChart({ series, labels }: { series: Series[]; labels: string[] }) {
  const { theme } = useUI();
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const onResize = (): void => chart.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const c = CHART[theme];
    chart.setOption({
      backgroundColor: "transparent",
      grid: { left: 46, right: 26, top: series.length > 1 ? 30 : 18, bottom: 22 },
      tooltip: {
        trigger: "axis",
        appendToBody: true,
        extraCssText: "z-index: 120;",
        valueFormatter: (v: unknown): string =>
          typeof v === "number"
            ? Math.abs(v) >= 1000
              ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
              : String(Math.round(v * 100) / 100)
            : "—",
      },
      legend:
        series.length > 1
          ? { top: 0, textStyle: { color: c.legend, fontSize: 11 }, itemWidth: 14, itemHeight: 8 }
          : undefined,
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: c.axis, fontSize: 10 },
        axisLine: { lineStyle: { color: c.grid } },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        axisLabel: { color: c.axis, fontSize: 10 },
        splitLine: { lineStyle: { color: c.split } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line" as const,
        data: s.data,
        showSymbol: false,
        connectNulls: true,
        lineStyle: { width: 1.5, color: s.color },
        itemStyle: { color: s.color },
      })),
    });
  }, [series, labels, theme]);

  return <div ref={ref} className="chart" />;
}

export function Spark({ a, b }: { a: (number | null)[]; b: (number | null)[] }) {
  const { lang } = useUI();
  const pts = (arr: (number | null)[]): string => {
    const n = Math.max(2, arr.length);
    return arr
      .flatMap((v, i) =>
        v === null
          ? []
          : [
              `${((i / (n - 1)) * 100).toFixed(1)},${(40 - (Math.min(100, Math.max(0, v)) / 100) * 36 - 2).toFixed(1)}`,
            ],
      )
      .join(" ");
  };
  if (a.length < 2) return <div className="spark-empty" />;
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none">
      <title>{t(lang, "gpu.sparkTitle")}</title>
      <polyline
        points={pts(a)}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: "var(--spark-a)" }}
      />
      <polyline
        points={pts(b)}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: "var(--spark-b)" }}
      />
    </svg>
  );
}
