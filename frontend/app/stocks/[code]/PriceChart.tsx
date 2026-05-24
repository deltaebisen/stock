"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type UTCTimestamp,
} from "lightweight-charts";

type ApiQuote = {
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjustment_open: number | null;
  adjustment_high: number | null;
  adjustment_low: number | null;
  adjustment_close: number | null;
  adjustment_volume: number | null;
};

type Range = "1M" | "3M" | "6M" | "1Y" | "5Y" | "ALL";

const RANGES: { key: Range; label: string; days: number | null }[] = [
  { key: "1M", label: "1M", days: 30 },
  { key: "3M", label: "3M", days: 90 },
  { key: "6M", label: "6M", days: 180 },
  { key: "1Y", label: "1Y", days: 365 },
  { key: "5Y", label: "5Y", days: 365 * 5 },
  { key: "ALL", label: "ALL", days: null },
];

function toUnix(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000) as UTCTimestamp;
}

export default function PriceChart({ quotes }: { quotes: ApiQuote[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [range, setRange] = useState<Range>("1Y");
  const [useAdjusted, setUseAdjusted] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#161b22" },
        textColor: "#c9d1d9",
        fontFamily:
          'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      },
      grid: {
        vertLines: { color: "#21262d" },
        horzLines: { color: "#21262d" },
      },
      rightPriceScale: { borderColor: "#30363d" },
      timeScale: {
        borderColor: "#30363d",
        timeVisible: false,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#3fb950",
      downColor: "#f85149",
      borderUpColor: "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
    });

    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      },
    );
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    candle.priceScale().applyOptions({
      scaleMargins: { top: 0.05, bottom: 0.25 },
    });

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;

    const ro = new ResizeObserver(() => chart.timeScale().fitContent());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candle = candleRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!candle || !volume || !chart) return;

    const cutoffMs = (() => {
      const r = RANGES.find((r) => r.key === range);
      if (!r || r.days === null) return null;
      return Date.now() - r.days * 86400 * 1000;
    })();

    const filtered = cutoffMs === null
      ? quotes
      : quotes.filter((q) => new Date(q.trade_date + "T00:00:00Z").getTime() >= cutoffMs);

    const candleData: CandlestickData[] = [];
    const volumeData: HistogramData[] = [];

    for (const q of filtered) {
      const o = useAdjusted ? q.adjustment_open ?? q.open : q.open;
      const h = useAdjusted ? q.adjustment_high ?? q.high : q.high;
      const l = useAdjusted ? q.adjustment_low ?? q.low : q.low;
      const c = useAdjusted ? q.adjustment_close ?? q.close : q.close;
      const v = useAdjusted ? q.adjustment_volume ?? q.volume : q.volume;
      if (o === null || h === null || l === null || c === null) continue;
      const time = toUnix(q.trade_date);
      candleData.push({ time, open: o, high: h, low: l, close: c });
      if (v !== null) {
        volumeData.push({
          time,
          value: v,
          color: c >= o ? "rgba(63, 185, 80, 0.45)" : "rgba(248, 81, 73, 0.45)",
        });
      }
    }

    candle.setData(candleData);
    volume.setData(volumeData);
    chart.timeScale().fitContent();
  }, [quotes, range, useAdjusted]);

  return (
    <div className="card chart-card">
      <div className="chart-toolbar">
        <div className="range-group">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={r.key === range ? "active" : ""}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={useAdjusted}
            onChange={(e) => setUseAdjusted(e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          調整後株価 (split/併合反映)
        </label>
      </div>
      <div ref={containerRef} className="chart-body" />
    </div>
  );
}
