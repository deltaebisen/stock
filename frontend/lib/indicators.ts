/**
 * テクニカル指標の計算。入力配列と同じ長さの配列を返し、計算に必要な
 * バー数が揃うまでは null を入れる (lightweight-charts は null を素直に gap 扱い)。
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
