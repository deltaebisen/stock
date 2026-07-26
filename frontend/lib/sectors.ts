import "server-only";
import { query } from "./db";

/**
 * セクターローテーション用のクエリ群。
 *
 * 価格は **生の close + adjustment_factor の累積で自前調整**する。
 * DB の adjustment_* 列は fetch_prices が INSERT IGNORE で過去行を更新しないため、
 * 後から起きた分割が過去に反映されず、分割日に -50% / -75% の偽ギャップが残る
 * (backend/src/backtest.py の load_quotes と同じ理由・同じ扱い)。
 *
 * 期間リターンは
 *   ret = (close_end / close_start) / Π(adjustment_factor in (start, end]) - 1
 * で求める。MariaDB に積の集約が無いので、分割行 (factor <> 1) だけ引いて JS 側で掛ける。
 */

export type SectorReturnRow = {
  sector_code: string;
  sector_name: string;
  count: number;
  /** 期間キー -> 等ウェイト平均リターン (%) */
  returns: Record<string, number | null>;
};

export type PeriodDef = { key: string; label: string; bars: number };

/** ヒートマップの期間 (営業日数ベース) */
export const PERIODS: PeriodDef[] = [
  { key: "1w", label: "1週", bars: 5 },
  { key: "1m", label: "1ヶ月", bars: 20 },
  { key: "3m", label: "3ヶ月", bars: 60 },
  { key: "6m", label: "6ヶ月", bars: 120 },
  { key: "1y", label: "1年", bars: 240 },
];

type SectorLevel = "sector33" | "sector17";

/**
 * プロセス内 TTL キャッシュ。
 *
 * 元データは日次バッチ (17:00 JST の prices-diff) でしか変わらないのに、集計は
 * 5.4M 行のテーブルを日付レンジで舐めるので NAS では 1 リクエスト数秒かかる。
 * 同じ内容を毎回引き直す意味が無いので、10 分だけ使い回す。
 */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function recentTradeDates(maxBars: number): Promise<string[]> {
  return cached(`dates:${maxBars}`, async () => {
    const rows = await query<{ trade_date: string }>(
      "SELECT DISTINCT trade_date FROM daily_quotes ORDER BY trade_date DESC LIMIT ?",
      [maxBars + 1],
    );
    return rows.map((r) => r.trade_date);
  });
}

/**
 * 業種別の期間リターン (等ウェイト = 構成銘柄の単純平均)。
 * 各期間の起点は「最新営業日から N 営業日前」。
 */
export async function getSectorReturns(
  level: SectorLevel = "sector33",
): Promise<{ asOf: string | null; rows: SectorReturnRow[]; market: Record<string, number | null> }> {
  return cached(`returns:${level}`, () => computeSectorReturns(level));
}

async function computeSectorReturns(
  level: SectorLevel,
): Promise<{ asOf: string | null; rows: SectorReturnRow[]; market: Record<string, number | null> }> {
  const codeCol = `${level}_code`;
  const nameCol = `${level}_name`;

  const maxBars = Math.max(...PERIODS.map((p) => p.bars));
  const dates = await recentTradeDates(maxBars);
  if (dates.length === 0) return { asOf: null, rows: [], market: {} };

  const asOf = dates[0];
  // 期間ごとの起点日 (足りない期間はスキップ)
  const anchors = new Map<string, string>();
  for (const p of PERIODS) {
    const d = dates[p.bars];
    if (d) anchors.set(p.key, d);
  }
  const anchorDates = [asOf, ...anchors.values()];
  const oldest = anchorDates[anchorDates.length - 1] ?? asOf;

  const [closes, splits, listed] = await Promise.all([
    query<{ code: string; trade_date: string; close: number }>(
      `SELECT code, trade_date, close FROM daily_quotes
        WHERE trade_date IN (${anchorDates.map(() => "?").join(",")})
          AND close IS NOT NULL`,
      anchorDates,
    ),
    query<{ code: string; trade_date: string; adjustment_factor: number }>(
      `SELECT code, trade_date, adjustment_factor FROM daily_quotes
        WHERE trade_date > ? AND trade_date <= ? AND adjustment_factor <> 1`,
      [oldest, asOf],
    ),
    query<{ code: string; sector_code: string | null; sector_name: string | null }>(
      `SELECT code, ${codeCol} AS sector_code, ${nameCol} AS sector_name FROM listed_info`,
    ),
  ]);

  // code -> date -> close
  const closeMap = new Map<string, Map<string, number>>();
  for (const r of closes) {
    let m = closeMap.get(r.code);
    if (!m) closeMap.set(r.code, (m = new Map()));
    m.set(r.trade_date, Number(r.close));
  }
  // code -> [(date, factor)]
  const splitMap = new Map<string, { d: string; f: number }[]>();
  for (const r of splits) {
    const arr = splitMap.get(r.code) ?? [];
    arr.push({ d: r.trade_date, f: Number(r.adjustment_factor) });
    splitMap.set(r.code, arr);
  }

  /** (start, end] の分割係数の積 */
  function splitProduct(code: string, start: string): number {
    const arr = splitMap.get(code);
    if (!arr) return 1;
    let p = 1;
    for (const s of arr) if (s.d > start && s.d <= asOf) p *= s.f;
    return p;
  }

  type Acc = { name: string; sums: Record<string, number>; counts: Record<string, number>; codes: Set<string> };
  const bySector = new Map<string, Acc>();
  const marketSums: Record<string, number> = {};
  const marketCounts: Record<string, number> = {};

  for (const li of listed) {
    if (!li.sector_code) continue;
    const m = closeMap.get(li.code);
    if (!m) continue;
    const end = m.get(asOf);
    if (!end) continue;

    let acc = bySector.get(li.sector_code);
    if (!acc) {
      acc = { name: li.sector_name ?? li.sector_code, sums: {}, counts: {}, codes: new Set() };
      bySector.set(li.sector_code, acc);
    }
    acc.codes.add(li.code);

    for (const p of PERIODS) {
      const startDate = anchors.get(p.key);
      if (!startDate) continue;
      const start = m.get(startDate);
      if (!start || start <= 0) continue;
      const ret = (end / start / splitProduct(li.code, startDate) - 1) * 100;
      if (!Number.isFinite(ret)) continue;
      acc.sums[p.key] = (acc.sums[p.key] ?? 0) + ret;
      acc.counts[p.key] = (acc.counts[p.key] ?? 0) + 1;
      marketSums[p.key] = (marketSums[p.key] ?? 0) + ret;
      marketCounts[p.key] = (marketCounts[p.key] ?? 0) + 1;
    }
  }

  const rows: SectorReturnRow[] = [...bySector.entries()]
    .map(([code, acc]) => {
      const returns: Record<string, number | null> = {};
      for (const p of PERIODS) {
        const n = acc.counts[p.key] ?? 0;
        returns[p.key] = n > 0 ? acc.sums[p.key] / n : null;
      }
      return { sector_code: code, sector_name: acc.name, count: acc.codes.size, returns };
    })
    .sort((a, b) => (b.returns["1m"] ?? -999) - (a.returns["1m"] ?? -999));

  const market: Record<string, number | null> = {};
  for (const p of PERIODS) {
    const n = marketCounts[p.key] ?? 0;
    market[p.key] = n > 0 ? marketSums[p.key] / n : null;
  }

  return { asOf, rows, market };
}

export type RsSeries = {
  sector_code: string;
  sector_name: string;
  /** 日付 (昇順) */
  dates: string[];
  /** 業種等ウェイト指数 (起点 = 100) */
  index: number[];
  /** 相対強度 = 業種指数 / 全銘柄等ウェイト指数 (起点 = 100) */
  rs: number[];
  /** 期間の RS 変化率 (%) */
  rsChange: number;
};

/**
 * 業種等ウェイト指数と、全銘柄等ウェイト指数に対する相対強度の時系列。
 *
 * 日次リターンを SQL 側で業種平均まで潰してから返す (銘柄 × 日付を Node に持ってくると
 * 100 万行級になるため)。分割日は factor で割って偽ギャップを除去する。
 */
export async function getSectorRelativeStrength(
  bars: number = 120,
  level: SectorLevel = "sector33",
  step: number = 5,
): Promise<{ asOf: string | null; series: RsSeries[] }> {
  return cached(`rs:${level}:${bars}:${step}`, () => computeSectorRelativeStrength(bars, level, step));
}

async function computeSectorRelativeStrength(
  bars: number,
  level: SectorLevel,
  step: number,
): Promise<{ asOf: string | null; series: RsSeries[] }> {
  const codeCol = `${level}_code`;
  const nameCol = `${level}_name`;

  const dates = await recentTradeDates(bars);
  if (dates.length === 0) return { asOf: null, series: [] };
  const asOf = dates[0];

  // 全営業日ではなく step 営業日おきのアンカー日だけを見る (既定 5 = 週次)。
  // 日次で LAG を回すと 5.4M 行のテーブルに対する窓関数になり、NAS の MariaDB では
  // 3 分以上かかる。ローテーションの俯瞰には週次で十分。
  const anchors: string[] = [];
  for (let i = dates.length - 1; i >= 0; i -= step) anchors.push(dates[i]);
  if (anchors[anchors.length - 1] !== asOf) anchors.push(asOf);
  const from = anchors[0];

  const [closes, splits, listed] = await Promise.all([
    query<{ code: string; trade_date: string; close: number }>(
      `SELECT code, trade_date, close FROM daily_quotes
        WHERE trade_date IN (${anchors.map(() => "?").join(",")}) AND close IS NOT NULL`,
      anchors,
    ),
    query<{ code: string; trade_date: string; adjustment_factor: number }>(
      `SELECT code, trade_date, adjustment_factor FROM daily_quotes
        WHERE trade_date > ? AND trade_date <= ? AND adjustment_factor <> 1`,
      [from, asOf],
    ),
    query<{ code: string; sector_code: string | null; sector_name: string | null }>(
      `SELECT code, ${codeCol} AS sector_code, ${nameCol} AS sector_name FROM listed_info
        WHERE ${codeCol} IS NOT NULL`,
    ),
  ]);

  const closeMap = new Map<string, Map<string, number>>();
  for (const r of closes) {
    let m = closeMap.get(r.code);
    if (!m) closeMap.set(r.code, (m = new Map()));
    m.set(r.trade_date, Number(r.close));
  }
  const splitMap = new Map<string, { d: string; f: number }[]>();
  for (const r of splits) {
    const arr = splitMap.get(r.code) ?? [];
    arr.push({ d: r.trade_date, f: Number(r.adjustment_factor) });
    splitMap.set(r.code, arr);
  }

  /** 起点 from から各アンカー日までの累積リターン (分割調整込み、倍率) */
  function growth(code: string, at: string): number | null {
    const m = closeMap.get(code);
    if (!m) return null;
    const start = m.get(from);
    const end = m.get(at);
    if (!start || !end || start <= 0) return null;
    let p = 1;
    for (const s of splitMap.get(code) ?? []) if (s.d > from && s.d <= at) p *= s.f;
    return end / start / p;
  }

  // 業種ごと・日付ごとに構成銘柄の等ウェイト平均を取る
  const bySector = new Map<string, { name: string; sums: number[]; counts: number[] }>();
  const marketSums = new Array(anchors.length).fill(0);
  const marketCounts = new Array(anchors.length).fill(0);

  for (const li of listed) {
    if (!li.sector_code) continue;
    let acc = bySector.get(li.sector_code);
    if (!acc) {
      acc = {
        name: li.sector_name ?? li.sector_code,
        sums: new Array(anchors.length).fill(0),
        counts: new Array(anchors.length).fill(0),
      };
      bySector.set(li.sector_code, acc);
    }
    anchors.forEach((d, i) => {
      const g = growth(li.code, d);
      if (g === null || !Number.isFinite(g)) return;
      acc!.sums[i] += g;
      acc!.counts[i] += 1;
      marketSums[i] += g;
      marketCounts[i] += 1;
    });
  }

  const marketIndex = anchors.map((_, i) =>
    marketCounts[i] > 0 ? (marketSums[i] / marketCounts[i]) * 100 : 100,
  );

  const series: RsSeries[] = [...bySector.entries()]
    .filter(([, acc]) => acc.counts[acc.counts.length - 1] > 0)
    .map(([code, acc]) => {
      const index = acc.sums.map((s, i) => (acc.counts[i] > 0 ? (s / acc.counts[i]) * 100 : 100));
      const rs = index.map((v, i) => (v / (marketIndex[i] || 100)) * 100);
      const first = rs[0] ?? 100;
      const last = rs[rs.length - 1] ?? 100;
      return {
        sector_code: code,
        sector_name: acc.name,
        dates: anchors,
        index,
        rs,
        rsChange: ((last - first) / first) * 100,
      };
    });

  series.sort((a, b) => b.rsChange - a.rsChange);
  return { asOf, series };
}

export type ConstituentRow = {
  code: string;
  company_name: string | null;
  market_name: string | null;
  scale_category: string | null;
  last_close: number | null;
  ret: number | null;
  avg_turnover: number | null;
};

/** 業種内の銘柄を期間リターン順に並べる (ドリルダウン用) */
export async function getSectorConstituents(
  sectorCode: string,
  bars: number = 20,
  level: SectorLevel = "sector33",
): Promise<{ asOf: string | null; sectorName: string | null; rows: ConstituentRow[] }> {
  return cached(`constituents:${level}:${sectorCode}:${bars}`, () =>
    computeSectorConstituents(sectorCode, bars, level),
  );
}

async function computeSectorConstituents(
  sectorCode: string,
  bars: number,
  level: SectorLevel,
): Promise<{ asOf: string | null; sectorName: string | null; rows: ConstituentRow[] }> {
  const codeCol = `${level}_code`;
  const nameCol = `${level}_name`;

  const dates = await recentTradeDates(bars);
  if (dates.length === 0) return { asOf: null, sectorName: null, rows: [] };
  const asOf = dates[0];
  const startDate = dates[Math.min(bars, dates.length - 1)];

  const [listed, closes, splits, turnover] = await Promise.all([
    query<{ code: string; company_name: string | null; market_name: string | null; scale_category: string | null; sector_name: string | null }>(
      `SELECT code, company_name, market_name, scale_category, ${nameCol} AS sector_name
         FROM listed_info WHERE ${codeCol} = ? ORDER BY code`,
      [sectorCode],
    ),
    query<{ code: string; trade_date: string; close: number }>(
      `SELECT q.code, q.trade_date, q.close FROM daily_quotes q
         JOIN listed_info li ON li.code = q.code AND li.${codeCol} = ?
        WHERE q.trade_date IN (?, ?) AND q.close IS NOT NULL`,
      [sectorCode, asOf, startDate],
    ),
    query<{ code: string; adjustment_factor: number }>(
      `SELECT q.code, q.adjustment_factor FROM daily_quotes q
         JOIN listed_info li ON li.code = q.code AND li.${codeCol} = ?
        WHERE q.trade_date > ? AND q.trade_date <= ? AND q.adjustment_factor <> 1`,
      [sectorCode, startDate, asOf],
    ),
    query<{ code: string; avg_turnover: number }>(
      `SELECT q.code, AVG(q.turnover_value) AS avg_turnover FROM daily_quotes q
         JOIN listed_info li ON li.code = q.code AND li.${codeCol} = ?
        WHERE q.trade_date BETWEEN ? AND ?
        GROUP BY q.code`,
      [sectorCode, startDate, asOf],
    ),
  ]);

  const closeMap = new Map<string, Map<string, number>>();
  for (const r of closes) {
    let m = closeMap.get(r.code);
    if (!m) closeMap.set(r.code, (m = new Map()));
    m.set(r.trade_date, Number(r.close));
  }
  const factorMap = new Map<string, number>();
  for (const r of splits) {
    factorMap.set(r.code, (factorMap.get(r.code) ?? 1) * Number(r.adjustment_factor));
  }
  const turnoverMap = new Map(turnover.map((t) => [t.code, Number(t.avg_turnover)]));

  const rows: ConstituentRow[] = listed.map((li) => {
    const m = closeMap.get(li.code);
    const end = m?.get(asOf) ?? null;
    const start = m?.get(startDate) ?? null;
    const ret =
      end && start && start > 0
        ? (end / start / (factorMap.get(li.code) ?? 1) - 1) * 100
        : null;
    return {
      code: li.code,
      company_name: li.company_name,
      market_name: li.market_name,
      scale_category: li.scale_category,
      last_close: end,
      ret,
      avg_turnover: turnoverMap.get(li.code) ?? null,
    };
  });

  rows.sort((a, b) => (b.ret ?? -9999) - (a.ret ?? -9999));
  return { asOf, sectorName: listed[0]?.sector_name ?? null, rows };
}
