import "server-only";
import {
  cached,
  computeGroupConstituents,
  computeGroupRelativeStrength,
  computeGroupReturns,
  PERIODS,
  type ConstituentRow,
  type GroupReturnRow,
  type RsSeries,
} from "./grouping";
import { sectorSource, type SectorLevel } from "./sources/sectorSource";

/**
 * 業種 (33業種 / 17業種) 別の集計。
 *
 * 計算本体は lib/grouping.ts にあり、ここは「業種をグループとして渡す」だけの
 * 薄いラッパー。テーマ版 (lib/themes.ts) と同じ計算・同じキャッシュ機構を共有する。
 */

export { PERIODS };
export type { PeriodDef } from "./grouping";
export type { SectorLevel };

/** 画面互換のため業種向けの列名 (sector_*) にして返す */
export type SectorReturnRow = {
  sector_code: string;
  sector_name: string;
  count: number;
  returns: Record<string, number | null>;
};

export type SectorRsSeries = Omit<RsSeries, "group_code" | "group_name"> & {
  sector_code: string;
  sector_name: string;
};

export type { ConstituentRow };

function toSectorRow(r: GroupReturnRow): SectorReturnRow {
  return {
    sector_code: r.group_code,
    sector_name: r.group_name,
    count: r.count,
    returns: r.returns,
  };
}

function toSectorSeries(s: RsSeries): SectorRsSeries {
  const { group_code, group_name, ...rest } = s;
  return { sector_code: group_code, sector_name: group_name, ...rest };
}

/** 業種別の期間リターン (等ウェイト = 構成銘柄の単純平均) */
export async function getSectorReturns(
  level: SectorLevel = "sector33",
): Promise<{ asOf: string | null; rows: SectorReturnRow[]; market: Record<string, number | null> }> {
  const src = sectorSource(level);
  return cached(`returns:${src.key}`, async () => {
    const { asOf, rows, market } = await computeGroupReturns(src);
    return { asOf, rows: rows.map(toSectorRow), market };
  });
}

/** 業種等ウェイト指数と、全銘柄等ウェイト指数に対する相対強度の時系列 */
export async function getSectorRelativeStrength(
  bars: number = 120,
  level: SectorLevel = "sector33",
  step: number = 5,
): Promise<{ asOf: string | null; series: SectorRsSeries[] }> {
  const src = sectorSource(level);
  return cached(`rs:${src.key}:${bars}:${step}`, async () => {
    const { asOf, series } = await computeGroupRelativeStrength(src, bars, step);
    return { asOf, series: series.map(toSectorSeries) };
  });
}

/** 業種内の銘柄を期間リターン順に並べる (ドリルダウン用) */
export async function getSectorConstituents(
  sectorCode: string,
  bars: number = 20,
  level: SectorLevel = "sector33",
): Promise<{ asOf: string | null; sectorName: string | null; rows: ConstituentRow[] }> {
  const src = sectorSource(level);
  return cached(`constituents:${src.key}:${sectorCode}:${bars}`, async () => {
    const { asOf, groupName, rows } = await computeGroupConstituents(src, sectorCode, bars);
    return { asOf, sectorName: groupName, rows };
  });
}
