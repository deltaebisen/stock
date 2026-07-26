import "server-only";
import { query } from "./db";

/**
 * 銘柄を「グループ」でまとめて集計する共通ロジック。
 *
 * グループの実体は 33業種 / 17業種 (listed_info の列) と 投資テーマ (themes /
 * theme_members テーブル) の 2 系統あるが、集計側が知る必要があるのは
 * 「(グループ, 銘柄) の対応表」と「市場平均の母集団」だけなので、そこを
 * GroupSource で抽象化して計算本体を 1 つにしてある。
 *
 * **テーマは 1 銘柄が複数グループに属する多対多**。members() は同じ code を
 * 複数行返してよい。そのため市場平均 (RS の分母) は members() ではなく
 * universe() の重複なし銘柄集合で計算する。members() で数えると、テーマを多く
 * 持つ銘柄が母集団に複数回入って平均が歪む。
 *
 * 価格は生の close + adjustment_factor の将来累積で遡及調整する。DB の
 * adjustment_* 列は fetch_prices が INSERT IGNORE で過去行を更新しないため、
 * 後から起きた分割が反映されず分割日に偽ギャップが残る (backend の
 * load_quotes と同じ理由・同じ扱い)。
 */

export type GroupMember = { code: string; group_code: string; group_name: string };

export type GroupSource = {
  /** キャッシュキーの prefix */
  key: string;
  /** (グループ, 銘柄) の対応表。多対多可 (同じ code が複数行あってよい) */
  members(): Promise<GroupMember[]>;
  /** 市場平均の母集団。**重複なしの銘柄コード** */
  universe(): Promise<string[]>;
  /** 1 グループのメンバーと表示名 (ドリルダウン用) */
  group(groupCode: string): Promise<{ name: string | null; codes: string[] }>;
};

export type PeriodDef = { key: string; label: string; bars: number };

/** ヒートマップの期間 (営業日数ベース)。週次で見る想定なので 1/3/6/12 ヶ月 */
export const PERIODS: PeriodDef[] = [
  { key: "1m", label: "1ヶ月", bars: 20 },
  { key: "3m", label: "3ヶ月", bars: 60 },
  { key: "6m", label: "6ヶ月", bars: 120 },
  { key: "12m", label: "12ヶ月", bars: 240 },
];

export type GroupReturnRow = {
  group_code: string;
  group_name: string;
  count: number;
  /** 期間キー -> 等ウェイト平均リターン (%) */
  returns: Record<string, number | null>;
};

export type RsSeries = {
  group_code: string;
  group_name: string;
  /** 最新日に価格が取れた構成銘柄数 (少なすぎるグループの除外に使う) */
  count: number;
  /** 日付 (昇順) */
  dates: string[];
  /** グループ等ウェイト指数 (起点 = 100) */
  index: number[];
  /** 相対強度 = グループ指数 / 市場等ウェイト指数 (起点 = 100) */
  rs: number[];
  /** 期間の RS 変化率 (%) */
  rsChange: number;
  /** 先週 (5 営業日前) 比の RS 変化率 (%) */
  rsChangeWeek: number;
  /** 先週比のグループリターン (%) */
  retWeek: number;
  /** 先週比の対市場超過リターン (%) */
  excessWeek: number;
  /** 比較に使った先週の日付 */
  weekAgoDate: string | null;
};

export type ConstituentRow = {
  code: string;
  company_name: string | null;
  market_name: string | null;
  scale_category: string | null;
  last_close: number | null;
  ret: number | null;
  avg_turnover: number | null;
};

/**
 * プロセス内 TTL キャッシュ。
 *
 * 元データは日次バッチ (17:00 JST の prices-diff) や週次のテーマ分類でしか
 * 変わらないのに、集計は 5.4M 行のテーブルを日付レンジで舐めるので NAS では
 * 1 リクエスト数秒かかる。同じ内容を毎回引き直す意味が無いので 10 分使い回す。
 * テーマを再分類した場合も、遅くとも 10 分で画面に反映される。
 */
const TTL_MS = 10 * 60 * 1000;
/** エントリ数の上限。RAM 960MiB の NAS なので上限なしで持たせない */
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; value: unknown }>();

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_ENTRIES) {
    // 挿入順 = 古い順なので先頭から捨てる
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size <= MAX_ENTRIES) break;
    }
  }
  return value;
}

export async function recentTradeDates(maxBars: number): Promise<string[]> {
  return cached(`dates:${maxBars}`, async () => {
    const rows = await query<{ trade_date: string }>(
      "SELECT DISTINCT trade_date FROM daily_quotes ORDER BY trade_date DESC LIMIT ?",
      [maxBars + 1],
    );
    return rows.map((r) => r.trade_date);
  });
}

/** 指定日の終値を code -> date -> close で返す */
async function loadCloses(dates: string[]): Promise<Map<string, Map<string, number>>> {
  const rows = await query<{ code: string; trade_date: string; close: number }>(
    `SELECT code, trade_date, close FROM daily_quotes
      WHERE trade_date IN (${dates.map(() => "?").join(",")}) AND close IS NOT NULL`,
    dates,
  );
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = out.get(r.code);
    if (!m) out.set(r.code, (m = new Map()));
    m.set(r.trade_date, Number(r.close));
  }
  return out;
}

/** (from, to] の分割係数を code -> [(date, factor)] で返す */
async function loadSplits(from: string, to: string): Promise<Map<string, { d: string; f: number }[]>> {
  const rows = await query<{ code: string; trade_date: string; adjustment_factor: number }>(
    `SELECT code, trade_date, adjustment_factor FROM daily_quotes
      WHERE trade_date > ? AND trade_date <= ? AND adjustment_factor <> 1`,
    [from, to],
  );
  const out = new Map<string, { d: string; f: number }[]>();
  for (const r of rows) {
    const arr = out.get(r.code) ?? [];
    arr.push({ d: r.trade_date, f: Number(r.adjustment_factor) });
    out.set(r.code, arr);
  }
  return out;
}

/** (start, end] の分割係数の積 */
function splitProduct(
  splits: Map<string, { d: string; f: number }[]>,
  code: string,
  start: string,
  end: string,
): number {
  const arr = splits.get(code);
  if (!arr) return 1;
  let p = 1;
  for (const s of arr) if (s.d > start && s.d <= end) p *= s.f;
  return p;
}

/** 平均。空なら null */
function mean(sum: number, n: number): number | null {
  return n > 0 ? sum / n : null;
}

/**
 * グループ別の期間リターン (等ウェイト = 構成銘柄の単純平均)。
 * 各期間の起点は「最新営業日から N 営業日前」。
 */
export async function computeGroupReturns(
  src: GroupSource,
): Promise<{ asOf: string | null; rows: GroupReturnRow[]; market: Record<string, number | null> }> {
  const maxBars = Math.max(...PERIODS.map((p) => p.bars));
  const dates = await recentTradeDates(maxBars);
  if (dates.length === 0) return { asOf: null, rows: [], market: {} };

  const asOf = dates[0];
  const anchors = new Map<string, string>(); // 期間キー -> 起点日
  for (const p of PERIODS) {
    const d = dates[p.bars];
    if (d) anchors.set(p.key, d);
  }
  const anchorDates = [asOf, ...anchors.values()];
  const oldest = anchorDates[anchorDates.length - 1] ?? asOf;

  const [closes, splits, members, universe] = await Promise.all([
    loadCloses(anchorDates),
    loadSplits(oldest, asOf),
    src.members(),
    src.universe(),
  ]);

  // 銘柄ごとの期間リターンを 1 回だけ計算して使い回す
  const retByCode = new Map<string, Record<string, number>>();
  for (const [code, m] of closes) {
    const end = m.get(asOf);
    if (!end) continue;
    const rets: Record<string, number> = {};
    for (const p of PERIODS) {
      const startDate = anchors.get(p.key);
      if (!startDate) continue;
      const start = m.get(startDate);
      if (!start || start <= 0) continue;
      const ret = (end / start / splitProduct(splits, code, startDate, asOf) - 1) * 100;
      if (Number.isFinite(ret)) rets[p.key] = ret;
    }
    retByCode.set(code, rets);
  }

  // 市場平均は universe (重複なし) で計算する。members() で数えると、
  // 複数グループに属する銘柄が母集団に多重カウントされる
  const marketSums: Record<string, number> = {};
  const marketCounts: Record<string, number> = {};
  for (const code of universe) {
    const rets = retByCode.get(code);
    if (!rets) continue;
    for (const p of PERIODS) {
      const v = rets[p.key];
      if (v === undefined) continue;
      marketSums[p.key] = (marketSums[p.key] ?? 0) + v;
      marketCounts[p.key] = (marketCounts[p.key] ?? 0) + 1;
    }
  }

  type Acc = {
    name: string;
    sums: Record<string, number>;
    counts: Record<string, number>;
    codes: Set<string>;
  };
  const byGroup = new Map<string, Acc>();
  for (const gm of members) {
    const rets = retByCode.get(gm.code);
    if (!rets) continue;
    let acc = byGroup.get(gm.group_code);
    if (!acc) {
      acc = { name: gm.group_name, sums: {}, counts: {}, codes: new Set() };
      byGroup.set(gm.group_code, acc);
    }
    acc.codes.add(gm.code);
    for (const p of PERIODS) {
      const v = rets[p.key];
      if (v === undefined) continue;
      acc.sums[p.key] = (acc.sums[p.key] ?? 0) + v;
      acc.counts[p.key] = (acc.counts[p.key] ?? 0) + 1;
    }
  }

  const rows: GroupReturnRow[] = [...byGroup.entries()]
    .map(([code, acc]) => {
      const returns: Record<string, number | null> = {};
      for (const p of PERIODS) returns[p.key] = mean(acc.sums[p.key] ?? 0, acc.counts[p.key] ?? 0);
      return { group_code: code, group_name: acc.name, count: acc.codes.size, returns };
    })
    .sort((a, b) => (b.returns["1m"] ?? -999) - (a.returns["1m"] ?? -999));

  const market: Record<string, number | null> = {};
  for (const p of PERIODS) market[p.key] = mean(marketSums[p.key] ?? 0, marketCounts[p.key] ?? 0);

  return { asOf, rows, market };
}

/**
 * グループ等ウェイト指数と、市場等ウェイト指数に対する相対強度の時系列。
 *
 * 全営業日ではなく step 営業日おきのアンカー日だけを見る (既定 5 = 週次)。
 * 日次で LAG を回すと 5.4M 行のテーブルに対する窓関数になり、NAS の MariaDB では
 * 3 分以上かかる。ローテーションの俯瞰には週次で十分。
 */
export async function computeGroupRelativeStrength(
  src: GroupSource,
  bars: number,
  step: number,
): Promise<{ asOf: string | null; series: RsSeries[] }> {
  const dates = await recentTradeDates(bars);
  if (dates.length === 0) return { asOf: null, series: [] };
  const asOf = dates[0];

  const anchors: string[] = [];
  for (let i = dates.length - 1; i >= 0; i -= step) anchors.push(dates[i]);
  if (anchors[anchors.length - 1] !== asOf) anchors.push(asOf);
  // 「先週」= 5 営業日前。step の刻みに必ずしも乗らないので明示的に足す
  const weekAgoDate = dates[Math.min(5, dates.length - 1)] ?? null;
  if (weekAgoDate && !anchors.includes(weekAgoDate)) {
    anchors.push(weekAgoDate);
    anchors.sort();
  }
  const from = anchors[0];

  const [closes, splits, members, universe] = await Promise.all([
    loadCloses(anchors),
    loadSplits(from, asOf),
    src.members(),
    src.universe(),
  ]);

  // 銘柄ごと・アンカー日ごとの累積成長率 (起点 from = 1.0) を 1 回だけ計算する
  const growthByCode = new Map<string, (number | null)[]>();
  for (const [code, m] of closes) {
    const start = m.get(from);
    if (!start || start <= 0) continue;
    const series = anchors.map((d) => {
      const end = m.get(d);
      if (!end) return null;
      const g = end / start / splitProduct(splits, code, from, d);
      return Number.isFinite(g) ? g : null;
    });
    growthByCode.set(code, series);
  }

  const marketSums = new Array(anchors.length).fill(0);
  const marketCounts = new Array(anchors.length).fill(0);
  for (const code of universe) {
    const g = growthByCode.get(code);
    if (!g) continue;
    g.forEach((v, i) => {
      if (v === null) return;
      marketSums[i] += v;
      marketCounts[i] += 1;
    });
  }
  const marketIndex = anchors.map((_, i) =>
    marketCounts[i] > 0 ? (marketSums[i] / marketCounts[i]) * 100 : 100,
  );

  const byGroup = new Map<string, { name: string; sums: number[]; counts: number[] }>();
  for (const gm of members) {
    const g = growthByCode.get(gm.code);
    let acc = byGroup.get(gm.group_code);
    if (!acc) {
      acc = {
        name: gm.group_name,
        sums: new Array(anchors.length).fill(0),
        counts: new Array(anchors.length).fill(0),
      };
      byGroup.set(gm.group_code, acc);
    }
    if (!g) continue;
    g.forEach((v, i) => {
      if (v === null) return;
      acc!.sums[i] += v;
      acc!.counts[i] += 1;
    });
  }

  const wIdx = weekAgoDate ? anchors.indexOf(weekAgoDate) : -1;
  const marketWeek =
    wIdx >= 0 && marketIndex[wIdx]
      ? (marketIndex[marketIndex.length - 1] / marketIndex[wIdx] - 1) * 100
      : 0;

  const series: RsSeries[] = [...byGroup.entries()]
    .filter(([, acc]) => acc.counts[acc.counts.length - 1] > 0)
    .map(([code, acc]) => {
      const index = acc.sums.map((s, i) => (acc.counts[i] > 0 ? (s / acc.counts[i]) * 100 : 100));
      const rs = index.map((v, i) => (v / (marketIndex[i] || 100)) * 100);
      const first = rs[0] ?? 100;
      const last = rs[rs.length - 1] ?? 100;
      const rsWeekAgo = wIdx >= 0 ? rs[wIdx] : last;
      const idxWeekAgo = wIdx >= 0 ? index[wIdx] : index[index.length - 1];
      const retWeek = idxWeekAgo > 0 ? (index[index.length - 1] / idxWeekAgo - 1) * 100 : 0;
      return {
        group_code: code,
        group_name: acc.name,
        count: acc.counts[acc.counts.length - 1] ?? 0,
        dates: anchors,
        index,
        rs,
        rsChange: ((last - first) / first) * 100,
        rsChangeWeek: rsWeekAgo > 0 ? ((last - rsWeekAgo) / rsWeekAgo) * 100 : 0,
        retWeek,
        excessWeek: retWeek - marketWeek,
        weekAgoDate,
      };
    });

  series.sort((a, b) => b.rsChangeWeek - a.rsChangeWeek);
  return { asOf, series };
}

/** グループ内の銘柄を期間リターン順に並べる (ドリルダウン用) */
export async function computeGroupConstituents(
  src: GroupSource,
  groupCode: string,
  bars: number,
): Promise<{ asOf: string | null; groupName: string | null; rows: ConstituentRow[] }> {
  const dates = await recentTradeDates(bars);
  if (dates.length === 0) return { asOf: null, groupName: null, rows: [] };
  const asOf = dates[0];
  const startDate = dates[Math.min(bars, dates.length - 1)];

  const { name, codes } = await src.group(groupCode);
  if (codes.length === 0) return { asOf, groupName: name, rows: [] };

  const ph = codes.map(() => "?").join(",");
  const [listed, closes, splits, turnover] = await Promise.all([
    query<{
      code: string;
      company_name: string | null;
      market_name: string | null;
      scale_category: string | null;
    }>(
      `SELECT code, company_name, market_name, scale_category FROM listed_info
        WHERE code IN (${ph}) ORDER BY code`,
      codes,
    ),
    query<{ code: string; trade_date: string; close: number }>(
      `SELECT code, trade_date, close FROM daily_quotes
        WHERE code IN (${ph}) AND trade_date IN (?, ?) AND close IS NOT NULL`,
      [...codes, asOf, startDate],
    ),
    query<{ code: string; adjustment_factor: number }>(
      `SELECT code, adjustment_factor FROM daily_quotes
        WHERE code IN (${ph}) AND trade_date > ? AND trade_date <= ? AND adjustment_factor <> 1`,
      [...codes, startDate, asOf],
    ),
    query<{ code: string; avg_turnover: number }>(
      `SELECT code, AVG(turnover_value) AS avg_turnover FROM daily_quotes
        WHERE code IN (${ph}) AND trade_date BETWEEN ? AND ?
        GROUP BY code`,
      [...codes, startDate, asOf],
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
      end && start && start > 0 ? (end / start / (factorMap.get(li.code) ?? 1) - 1) * 100 : null;
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
  return { asOf, groupName: name, rows };
}
