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
  type SeriesType,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  type IndicatorInstance,
  type IndicatorValues,
  INDICATOR_PANE,
  computeIndicator,
  isValidIndicator,
} from "@/lib/indicators";
import IndicatorMenu from "./IndicatorMenu";

// localStorage key (スキーマ変更時は v2 にバンプ)
const INDICATORS_STORAGE_KEY = "stock-chart-indicators-v1";

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

const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

// 初期セット (TradingView 風だが、過去互換で既存ユーザーが慣れた SMA 25/50/75 + MACD を default に)
const DEFAULT_INDICATORS: IndicatorInstance[] = [
  { id: "default-sma-25", type: "SMA", period: 25, color: "#f7b955" },
  { id: "default-sma-50", type: "SMA", period: 50, color: "#79c0ff" },
  { id: "default-sma-75", type: "SMA", period: 75, color: "#d2a8ff" },
  {
    id: "default-macd",
    type: "MACD",
    fast: 12,
    slow: 26,
    signal: 9,
    lineColor: "#58a6ff",
    signalColor: "#f7b955",
  },
];

function toUnix(dateStr: string): UTCTimestamp {
  return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 1000) as UTCTimestamp;
}

type ChartHandles = {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
};

type IndicatorEntry = {
  series: ISeriesApi<SeriesType>[];
  /** separate pane を使ってる場合の pane index (overlay なら undefined) */
  paneIndex?: number;
};

export default function PriceChart({ quotes }: { quotes: ApiQuote[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  // indicator id → 生成済み series エントリ (動的 add/remove)
  const dynRef = useRef<Map<string, IndicatorEntry>>(new Map());

  const [range, setRange] = useState<Range>("1Y");
  const [indicators, setIndicators] = useState<IndicatorInstance[]>(DEFAULT_INDICATORS);
  // 各 indicator の直近値 (chip 表示用)
  const [latestMap, setLatestMap] = useState<Map<string, (number | null)[]>>(new Map());
  // localStorage 復元が完了するまで保存しない (= SSR の DEFAULT で保存上書きを防ぐ)
  const restoredRef = useRef(false);

  // localStorage から復元 (CSR マウント時のみ)。SSR では DEFAULT のまま hydration、
  // マウント後に setIndicators で上書きする方式 (hydration mismatch 警告は出ない)。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(INDICATORS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter(isValidIndicator);
          // 完全に空でも (= ユーザーが全削除した状態) 復元する
          setIndicators(valid);
        }
      }
    } catch {
      // 壊れてたら DEFAULT のままで続行
    } finally {
      restoredRef.current = true;
    }
  }, []);

  // indicators 変更で localStorage に保存 (復元完了後のみ)
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(indicators));
    } catch {
      // QuotaExceeded など。指標構成は数 KB なので通常起きない
    }
  }, [indicators]);

  // --- 1. chart mount (一度きり) ---
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

    handlesRef.current = { chart, candle, volume };

    return () => {
      chart.remove();
      handlesRef.current = null;
      dynRef.current.clear();
    };
  }, []);

  // --- 2. quotes / indicators / range 変更で描画更新 ---
  // 設計: indicators 変更時は dynamic series を全 rebuild。インクリメンタル diff より
  // 確実で、5〜10 個程度の指標なら teardown→recreate は 1ms 未満で済む。
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;

    // データ変換 (常に全期間)
    const allTimes: UTCTimestamp[] = [];
    const allCandles: CandlestickData[] = [];
    const allVolumes: HistogramData[] = [];
    const allCloses: (number | null)[] = [];

    for (const q of quotes) {
      const o = q.adjustment_open ?? q.open;
      const high = q.adjustment_high ?? q.high;
      const l = q.adjustment_low ?? q.low;
      const c = q.adjustment_close ?? q.close;
      const v = q.adjustment_volume ?? q.volume;
      if (o === null || high === null || l === null || c === null) continue;
      const time = toUnix(q.trade_date);
      allTimes.push(time);
      allCandles.push({ time, open: o, high, low: l, close: c });
      allCloses.push(c);
      if (v !== null) {
        allVolumes.push({
          time,
          value: v,
          color: c >= o ? "rgba(63, 185, 80, 0.45)" : "rgba(248, 81, 73, 0.45)",
        });
      }
    }

    h.candle.setData(allCandles);
    h.volume.setData(allVolumes);

    // ---- 動的 indicator 系列の全 rebuild ----
    // 1) 既存 entry を teardown
    for (const entry of dynRef.current.values()) {
      for (const s of entry.series) {
        try {
          h.chart.removeSeries(s);
        } catch {
          // すでに削除済みは無視
        }
      }
    }
    dynRef.current.clear();
    // 余分な pane を削除して pane 0 だけ残す
    while (h.chart.panes().length > 1) {
      try {
        h.chart.removePane(h.chart.panes().length - 1);
      } catch {
        break;
      }
    }

    // 2) indicators を順に再生成
    let nextSepPaneIdx = 1;
    const newLatest = new Map<string, (number | null)[]>();
    for (const ind of indicators) {
      const isSep = INDICATOR_PANE[ind.type] === "separate";
      const paneIdx = isSep ? nextSepPaneIdx++ : 0;
      const series = createSeriesForIndicator(h.chart, ind, paneIdx);
      const computed = computeIndicator(ind, allCloses);
      applyComputedToSeries(series, ind, computed, allTimes);
      dynRef.current.set(ind.id, {
        series,
        paneIndex: isSep ? paneIdx : undefined,
      });
      newLatest.set(ind.id, computed.latest);
    }
    setLatestMap(newLatest);

    // ---- 表示範囲を range に合わせて制限 ----
    // setVisibleLogicalRange (バー index ベース) で全データ保持しつつ初期窓を絞る。
    // drag/wheel で過去側を広げると保持済みデータがそのまま描画される。
    const rangeDef = RANGES.find((r) => r.key === range);
    const totalBars = allTimes.length;
    if (rangeDef && rangeDef.days !== null && totalBars > 0) {
      const cutoffSec = Math.floor(
        (Date.now() - rangeDef.days * 86400 * 1000) / 1000,
      );
      let visibleBars = 0;
      for (let i = totalBars - 1; i >= 0; i--) {
        if ((allTimes[i] as number) < cutoffSec) break;
        visibleBars++;
      }
      visibleBars = Math.max(visibleBars, 1);
      h.chart.timeScale().setVisibleLogicalRange({
        from: totalBars - visibleBars,
        to: totalBars - 1,
      });
    } else {
      h.chart.timeScale().fitContent();
    }
  }, [quotes, indicators, range]);

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
        <IndicatorMenu
          indicators={indicators}
          setIndicators={setIndicators}
          latestValues={latestMap}
        />
      </div>
      <div ref={containerRef} className="chart-body" />
    </div>
  );
}

// =================================================================
// helpers
// =================================================================

function createSeriesForIndicator(
  chart: IChartApi,
  ind: IndicatorInstance,
  paneIdx: number,
): ISeriesApi<SeriesType>[] {
  switch (ind.type) {
    case "SMA":
    case "EMA": {
      const s = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      return [s];
    }
    case "BB": {
      const upper = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      const middle = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      const lower = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      return [upper, middle, lower];
    }
    case "MACD": {
      const line = chart.addSeries(
        LineSeries,
        {
          color: ind.lineColor,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      const signal = chart.addSeries(
        LineSeries,
        {
          color: ind.signalColor,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      const histo = chart.addSeries(
        HistogramSeries,
        {
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      return [line, signal, histo];
    }
    case "RSI": {
      const s = chart.addSeries(
        LineSeries,
        {
          color: ind.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        },
        paneIdx,
      );
      // 70/30 reference lines (axis label は出さない)
      s.createPriceLine({
        price: RSI_OVERBOUGHT,
        color: "rgba(248, 81, 73, 0.5)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: "",
      });
      s.createPriceLine({
        price: RSI_OVERSOLD,
        color: "rgba(63, 185, 80, 0.5)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: "",
      });
      return [s];
    }
  }
}

function applyComputedToSeries(
  series: ISeriesApi<SeriesType>[],
  ind: IndicatorInstance,
  computed: IndicatorValues,
  allTimes: UTCTimestamp[],
): void {
  switch (ind.type) {
    case "SMA":
    case "EMA":
    case "RSI": {
      (series[0] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[0], allTimes),
      );
      return;
    }
    case "BB": {
      (series[0] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[0], allTimes),
      );
      (series[1] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[1], allTimes),
      );
      (series[2] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[2], allTimes),
      );
      return;
    }
    case "MACD": {
      (series[0] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[0], allTimes),
      );
      (series[1] as ISeriesApi<"Line">).setData(
        toLineData(computed.series[1], allTimes),
      );
      const hist = computed.series[2];
      const histData: HistogramData[] = [];
      for (let i = 0; i < hist.length; i++) {
        const v = hist[i];
        if (v !== null) {
          histData.push({
            time: allTimes[i],
            value: v,
            color:
              v >= 0 ? "rgba(63, 185, 80, 0.6)" : "rgba(248, 81, 73, 0.6)",
          });
        }
      }
      (series[2] as ISeriesApi<"Histogram">).setData(histData);
      return;
    }
  }
}

function toLineData(
  values: ReadonlyArray<number | null>,
  times: UTCTimestamp[],
): LineData[] {
  const out: LineData[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null) out.push({ time: times[i], value: v });
  }
  return out;
}
