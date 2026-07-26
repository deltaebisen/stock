import "server-only";
import { query } from "./db";
import {
  cached,
  computeGroupConstituents,
  computeGroupRelativeStrength,
  computeGroupReturns,
  type ConstituentRow,
  type GroupReturnRow,
  type RsSeries,
} from "./grouping";
import { themeSource } from "./sources/themeSource";

/**
 * 投資テーマ別の集計。計算本体は lib/grouping.ts で業種版と共有する。
 *
 * テーマは 1 銘柄が複数に属する多対多なので、業種版と違い
 *   - 各テーマの銘柄数は重複を許して合計すると上場銘柄数を超える
 *   - 市場平均 (RS の分母) は全上場銘柄の重複なし集合で計算される (grouping.ts 側)
 * という点だけ読み方が異なる。
 */

export type ThemeReturnRow = GroupReturnRow;
export type ThemeRsSeries = RsSeries;
export type { ConstituentRow };

/** テーマ別の期間リターン (等ウェイト) */
export async function getThemeReturns(minConfidence = 0) {
  const src = themeSource(minConfidence);
  return cached(`returns:${src.key}`, () => computeGroupReturns(src));
}

/** テーマ等ウェイト指数と、全銘柄等ウェイト指数に対する相対強度の時系列 */
export async function getThemeRelativeStrength(bars = 120, minConfidence = 0, step = 5) {
  const src = themeSource(minConfidence);
  return cached(`rs:${src.key}:${bars}:${step}`, () =>
    computeGroupRelativeStrength(src, bars, step),
  );
}

/** テーマ内の銘柄を期間リターン順に並べる */
export async function getThemeConstituents(themeCode: string, bars = 20, minConfidence = 0) {
  const src = themeSource(minConfidence);
  return cached(`constituents:${src.key}:${themeCode}:${bars}`, () =>
    computeGroupConstituents(src, themeCode, bars),
  );
}

export type ThemeCatalogRow = { theme_code: string; theme_name: string; category: string };

/** テーマの定義一覧 (大分類つき)。画面のフィルタと列表示に使う */
export async function getThemeCatalog(): Promise<ThemeCatalogRow[]> {
  return cached("theme:catalog", () =>
    query<ThemeCatalogRow>(
      `SELECT theme_code, theme_name, category FROM themes
        WHERE is_active = 1 ORDER BY sort_order, theme_code`,
    ),
  );
}

export type ThemeMembership = {
  code: string;
  theme_code: string;
  theme_name: string;
  confidence: number;
};

/**
 * 指定銘柄が属するテーマ (多対多の逆引き)。
 * テーマ詳細画面で「この銘柄は他にどのテーマに入っているか」を出すのに使う。
 */
export async function getThemesForCodes(codes: string[]): Promise<Map<string, ThemeMembership[]>> {
  if (codes.length === 0) return new Map();
  const ph = codes.map(() => "?").join(",");
  const rows = await query<ThemeMembership>(
    `SELECT tm.code, tm.theme_code, t.theme_name, tm.confidence
       FROM theme_members tm
       JOIN themes t ON t.theme_code = tm.theme_code AND t.is_active = 1
      WHERE tm.code IN (${ph})
      ORDER BY tm.confidence DESC`,
    codes,
  );
  const out = new Map<string, ThemeMembership[]>();
  for (const r of rows) {
    const arr = out.get(r.code) ?? [];
    arr.push({ ...r, confidence: Number(r.confidence) });
    out.set(r.code, arr);
  }
  return out;
}

/** テーマ分類の実行状況 (画面に「まだ分類が終わっていない」を出すため) */
export async function getThemeCoverage(): Promise<{
  themes: number;
  classified: number;
  listed: number;
  assignments: number;
}> {
  return cached("theme:coverage", async () => {
    const rows = await query<{ themes: number; classified: number; listed: number; assignments: number }>(
      `SELECT
         (SELECT COUNT(*) FROM themes WHERE is_active = 1) AS themes,
         (SELECT COUNT(*) FROM theme_classification) AS classified,
         (SELECT COUNT(*) FROM listed_info) AS listed,
         (SELECT COUNT(*) FROM theme_members) AS assignments`,
    );
    const r = rows[0];
    return {
      themes: Number(r?.themes ?? 0),
      classified: Number(r?.classified ?? 0),
      listed: Number(r?.listed ?? 0),
      assignments: Number(r?.assignments ?? 0),
    };
  });
}
