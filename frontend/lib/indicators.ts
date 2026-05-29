/**
 * テクニカル指標の計算 + indicator instance 型定義 + factory / helpers。
 *
 * 設計思想:
 *  - chart の指標は **runtime に add/remove できるインスタンス** として扱う (TradingView 流)
 *  - 同じ type を異なるパラメータで複数追加可能 (SMA(25) と SMA(200) を別 chip として)
 *  - 各インスタンスは IndicatorInstance ユニオンで型付け、INDICATOR_PANE で overlay/separate を分岐
 *  - 計算ロジック (sma/ema/macd/bollinger/rsi) は引数配列と同長の (number|null)[] を返し、
 *    warmup 不足は null。複数 line を持つ指標 (BB/MACD) は { upper, middle, lower } 等の object を返す
 *  - PriceChart 側からは computeIndicator(ind, closes) を呼ぶと
 *    { series: (number|null)[][], latest: (number|null)[] } で line 数ぶんまとめて受け取れる
 */

export function sma(
  values: ReadonlyArray<number | null>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const window: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || Number.isNaN(v)) continue;
    window.push(v);
    sum += v;
    if (window.length > period) sum -= window.shift()!;
    if (window.length === period) out[i] = sum / period;
  }
  return out;
}

export function ema(
  values: ReadonlyArray<number | null>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let initSum = 0;
  let initCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || Number.isNaN(v)) {
      out[i] = prev;
      continue;
    }
    if (prev === null) {
      initSum += v;
      initCount++;
      if (initCount === period) {
        prev = initSum / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export type MacdResult = {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
};

export function macd(
  closes: ReadonlyArray<number | null>,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f !== null && s !== null ? f - s : null;
  });
  const signalLine = ema(macdLine, signalPeriod);
  const histogram: (number | null)[] = macdLine.map((m, i) => {
    const s = signalLine[i];
    return m !== null && s !== null ? m - s : null;
  });
  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Wilder smoothed RSI (デフォルト 14)。
 * 最初の `period` バーで単純平均→以降はワイルダー平滑化 (古典実装)。
 * gain / loss が両方 0 のフラット相場では 100 を返す (loss=0 → 1+∞ の極限)。
 */
export function rsi(
  closes: ReadonlyArray<number | null>,
  period = 14,
): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let prev: number | null = null;
  let avgGain = 0;
  let avgLoss = 0;
  let count = 0;

  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (c === null || Number.isNaN(c)) continue;
    if (prev === null) {
      prev = c;
      continue;
    }
    const change = c - prev;
    prev = c;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    count++;
    if (count <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (count === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export type BollingerResult = {
  middle: (number | null)[]; // SMA(period)
  upper: (number | null)[];  // middle + stddev * σ
  lower: (number | null)[];  // middle - stddev * σ
};

/**
 * Bollinger Bands (デフォルト 20 バー, 2σ)。
 * SMA 中心線 ± 標準偏差 × stddev。母分散ベース (分母 N) で世間の慣例に合わせる。
 * 期間中に null が混じる日があれば、その i は出力 null (gap)。
 */
// ---- Indicator instance model -------------------------------------------------

export type IndicatorType = "SMA" | "EMA" | "BB" | "MACD" | "RSI";

export interface SmaInstance {
  id: string;
  type: "SMA";
  period: number;
  color: string;
}
export interface EmaInstance {
  id: string;
  type: "EMA";
  period: number;
  color: string;
}
export interface BbInstance {
  id: string;
  type: "BB";
  period: number;
  stddev: number;
  color: string;
}
export interface MacdInstance {
  id: string;
  type: "MACD";
  fast: number;
  slow: number;
  signal: number;
  lineColor: string;
  signalColor: string;
}
export interface RsiInstance {
  id: string;
  type: "RSI";
  period: number;
  color: string;
}
export type IndicatorInstance =
  | SmaInstance
  | EmaInstance
  | BbInstance
  | MacdInstance
  | RsiInstance;

export const INDICATOR_LABEL: Record<IndicatorType, string> = {
  SMA: "SMA",
  EMA: "EMA",
  BB: "Bollinger Bands",
  MACD: "MACD",
  RSI: "RSI",
};

// overlay = candle pane (pane 0) に重ね描き
// separate = 各インスタンスが専用 pane を確保 (pane 1, 2, ...)
export const INDICATOR_PANE: Record<IndicatorType, "overlay" | "separate"> = {
  SMA: "overlay",
  EMA: "overlay",
  BB: "overlay",
  MACD: "separate",
  RSI: "separate",
};

const COLOR_PALETTE = [
  "#f7b955",
  "#79c0ff",
  "#d2a8ff",
  "#3fb950",
  "#ff7eb6",
  "#58a6ff",
  "#ffd866",
  "#f85149",
];

let _colorCursor = 0;
function nextColor(): string {
  const c = COLOR_PALETTE[_colorCursor % COLOR_PALETTE.length];
  _colorCursor++;
  return c;
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
}

export function makeIndicator(type: IndicatorType): IndicatorInstance {
  const id = uid();
  switch (type) {
    case "SMA":
      return { id, type, period: 25, color: nextColor() };
    case "EMA":
      return { id, type, period: 25, color: nextColor() };
    case "BB":
      return { id, type, period: 20, stddev: 2, color: nextColor() };
    case "MACD":
      return {
        id,
        type,
        fast: 12,
        slow: 26,
        signal: 9,
        lineColor: "#58a6ff",
        signalColor: "#f7b955",
      };
    case "RSI":
      return { id, type, period: 14, color: "#d2a8ff" };
  }
}

/** localStorage 復元時の型検証。壊れた / 旧スキーマの値を捨てるための gate */
export function isValidIndicator(x: unknown): x is IndicatorInstance {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string") return false;
  switch (o.type) {
    case "SMA":
    case "EMA":
      return typeof o.period === "number" && typeof o.color === "string";
    case "BB":
      return (
        typeof o.period === "number" &&
        typeof o.stddev === "number" &&
        typeof o.color === "string"
      );
    case "MACD":
      return (
        typeof o.fast === "number" &&
        typeof o.slow === "number" &&
        typeof o.signal === "number" &&
        typeof o.lineColor === "string" &&
        typeof o.signalColor === "string"
      );
    case "RSI":
      return typeof o.period === "number" && typeof o.color === "string";
    default:
      return false;
  }
}

export function describeIndicator(ind: IndicatorInstance): string {
  switch (ind.type) {
    case "SMA":
      return `SMA(${ind.period})`;
    case "EMA":
      return `EMA(${ind.period})`;
    case "BB":
      return `BB(${ind.period}, ${ind.stddev}σ)`;
    case "MACD":
      return `MACD(${ind.fast}/${ind.slow}/${ind.signal})`;
    case "RSI":
      return `RSI(${ind.period})`;
  }
}

function lastNonNull(arr: ReadonlyArray<number | null>): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

export type IndicatorValues = {
  /** 各 line/area の値配列 (closes と同じ長さ、warmup は null) */
  series: (number | null)[][];
  /** 各 line/area の直近非 null 値 */
  latest: (number | null)[];
};

export function computeIndicator(
  ind: IndicatorInstance,
  closes: ReadonlyArray<number | null>,
): IndicatorValues {
  switch (ind.type) {
    case "SMA": {
      const s = sma(closes, ind.period);
      return { series: [s], latest: [lastNonNull(s)] };
    }
    case "EMA": {
      const s = ema(closes, ind.period);
      return { series: [s], latest: [lastNonNull(s)] };
    }
    case "BB": {
      const b = bollinger(closes, ind.period, ind.stddev);
      return {
        series: [b.upper, b.middle, b.lower],
        latest: [lastNonNull(b.upper), lastNonNull(b.middle), lastNonNull(b.lower)],
      };
    }
    case "MACD": {
      const m = macd(closes, ind.fast, ind.slow, ind.signal);
      return {
        series: [m.macd, m.signal, m.histogram],
        latest: [lastNonNull(m.macd), lastNonNull(m.signal), lastNonNull(m.histogram)],
      };
    }
    case "RSI": {
      const s = rsi(closes, ind.period);
      return { series: [s], latest: [lastNonNull(s)] };
    }
  }
}

// ---- Indicator math (個別関数。computeIndicator が dispatch する) ---------

export function bollinger(
  values: ReadonlyArray<number | null>,
  period = 20,
  stddev = 2,
): BollingerResult {
  const middle: (number | null)[] = new Array(values.length).fill(null);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let sumSq = 0;
    let valid = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || Number.isNaN(v)) break;
      sum += v;
      sumSq += v * v;
      valid++;
    }
    if (valid !== period) continue;
    const m = sum / period;
    const variance = sumSq / period - m * m;
    const sd = Math.sqrt(Math.max(0, variance));
    middle[i] = m;
    upper[i] = m + stddev * sd;
    lower[i] = m - stddev * sd;
  }
  return { middle, upper, lower };
}
