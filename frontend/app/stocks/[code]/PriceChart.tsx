"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import { sma, macd } from "@/lib/indicators";

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

const SMA_PERIODS = [25, 50, 75] as const;
const SMA_COLORS: Record<(typeof SMA_PERIODS)[number], string> = {
  25: "#f7b955",
  50: "#79c0ff",
  75: "#d2a8ff",
};

const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

function toUnix(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000) as UTCTimestamp;
}

type ChartHandles = {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  smaSeries: Map<(typeof SMA_PERIODS)[number], ISeriesApi<"Line">>;
  macdLine: ISeriesApi<"Line">;
  macdSignal: ISeriesApi<"Line">;
  macdHist: ISeriesApi<"Histogram">;
};

export default function PriceChart({ quotes }: { quotes: ApiQuote[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);

  const [range, setRange] = useState<Range>("1Y");
  const [showMA, setShowMA] = useState(true);
  const [showMACD, setShowMACD] = useState(true);

  // chart 構築 (mount 時のみ)
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

    // Pane 0: candle + SMA lines (+ volume overlay)
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#3fb950",
      downColor: "#f85149",
      borderUpColor: "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    candle.priceScale().applyOptions({
      scaleMargins: { top: 0.05, bottom: 0.25 },
    });

    const smaSeries = new Map<(typeof SMA_PERIODS)[number], ISeriesApi<"Line">>();
    for (const p of SMA_PERIODS) {
      const s = chart.addSeries(LineSeries, {
        color: SMA_COLORS[p],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        title: `SMA${p}`,
      });
      smaSeries.set(p, s);
    }

    // Pane 1: MACD
    const macdHist = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "price", precision: 2, minMove: 0.01 }, title: "Hist" },
      1,
    );
    const macdLine = chart.addSeries(
      LineSeries,
      {
        color: "#58a6ff",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `MACD(${MACD_FAST},${MACD_SLOW})`,
      },
      1,
    );
    const macdSignal = chart.addSeries(
      LineSeries,
      {
        color: "#f7b955",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `Signal(${MACD_SIGNAL})`,
      },
      1,
    );

    handlesRef.current = {
      chart,
      candle,
      volume,
      smaSeries,
      macdLine,
      macdSignal,
      macdHist,
    };

    const ro = new ResizeObserver(() => chart.timeScale().fitContent());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      handlesRef.current = null;
    };
  }, []);

  // データ反映 (quotes / range / useAdjusted / トグル変更時)
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;

    const cutoffMs = (() => {
      const r = RANGES.find((r) => r.key === range);
      if (!r || r.days === null) return null;
      return Date.now() - r.days * 86400 * 1000;
    })();

    const filtered = cutoffMs === null
      ? quotes
      : quotes.filter((q) => new Date(q.trade_date + "T00:00:00Z").getTime() >= cutoffMs);

    const times: UTCTimestamp[] = [];
    const candleData: CandlestickData[] = [];
    const volumeData: HistogramData[] = [];
    const closes: (number | null)[] = [];

    // 常に split / 併合調整後の価格を使う (バックテスト前提)
    for (const q of filtered) {
      const o = q.adjustment_open ?? q.open;
      const high = q.adjustment_high ?? q.high;
      const l = q.adjustment_low ?? q.low;
      const c = q.adjustment_close ?? q.close;
      const v = q.adjustment_volume ?? q.volume;
      if (o === null || high === null || l === null || c === null) continue;
      const time = toUnix(q.trade_date);
      times.push(time);
      candleData.push({ time, open: o, high: high, low: l, close: c });
      closes.push(c);
      if (v !== null) {
        volumeData.push({
          time,
          value: v,
          color: c >= o ? "rgba(63, 185, 80, 0.45)" : "rgba(248, 81, 73, 0.45)",
        });
      }
    }

    h.candle.setData(candleData);
    h.volume.setData(volumeData);

    // SMA
    if (showMA) {
      for (const p of SMA_PERIODS) {
        const series = h.smaSeries.get(p)!;
        const values = sma(closes, p);
        const data: LineData[] = [];
        for (let i = 0; i < values.length; i++) {
          const val = values[i];
          if (val !== null) data.push({ time: times[i], value: val });
        }
        series.setData(data);
        series.applyOptions({ visible: true });
      }
    } else {
      for (const p of SMA_PERIODS) {
        h.smaSeries.get(p)!.applyOptions({ visible: false });
      }
    }

    // MACD
    if (showMACD) {
      const { macd: m, signal, histogram } = macd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
      const macdData: LineData[] = [];
      const signalData: LineData[] = [];
      const histData: HistogramData[] = [];
      for (let i = 0; i < times.length; i++) {
        if (m[i] !== null) macdData.push({ time: times[i], value: m[i]! });
        if (signal[i] !== null) signalData.push({ time: times[i], value: signal[i]! });
        if (histogram[i] !== null) {
          histData.push({
            time: times[i],
            value: histogram[i]!,
            color:
              histogram[i]! >= 0
                ? "rgba(63, 185, 80, 0.6)"
                : "rgba(248, 81, 73, 0.6)",
          });
        }
      }
      h.macdLine.setData(macdData);
      h.macdSignal.setData(signalData);
      h.macdHist.setData(histData);
      h.macdLine.applyOptions({ visible: true });
      h.macdSignal.applyOptions({ visible: true });
      h.macdHist.applyOptions({ visible: true });
    } else {
      h.macdLine.applyOptions({ visible: false });
      h.macdSignal.applyOptions({ visible: false });
      h.macdHist.applyOptions({ visible: false });
    }

    h.chart.timeScale().fitContent();
  }, [quotes, range, showMA, showMACD]);

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
            checked={showMA}
            onChange={(e) => setShowMA(e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          SMA (25/50/75)
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showMACD}
            onChange={(e) => setShowMACD(e.target.checked)}
            style={{ width: 14, height: 14 }}
          />
          MACD (12/26/9)
        </label>
      </div>
      <div ref={containerRef} className="chart-body" />
    </div>
  );
}
