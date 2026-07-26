import "server-only";
import { query } from "../db";
import type { GroupSource } from "../grouping";

/**
 * 投資テーマ (themes / theme_members) をグループとして扱う GroupSource。
 *
 * **1 銘柄が複数テーマに属する多対多**なので members() は同じ code を複数回返す。
 * 市場平均の母集団 universe() は全上場銘柄 (重複なし) にする。
 *
 * theme_members には listed_info への FK が無い (fetch_listed が毎日 TRUNCATE
 * するため)。上場廃止銘柄が残り得るので JOIN listed_info で落とす。
 *
 * minConfidence は「LLM の確信度がこれ未満の割当を無視する」閾値。再分類なしで
 * ノイズを調整できる。キャッシュキーに焼き込んで閾値違いが混ざらないようにする。
 */
export function themeSource(minConfidence = 0): GroupSource {
  const conf = Math.max(0, Math.min(1, minConfidence));

  return {
    key: `theme:c${Math.round(conf * 100)}`,

    async members() {
      const rows = await query<{ code: string; group_code: string; group_name: string }>(
        `SELECT tm.code, tm.theme_code AS group_code, t.theme_name AS group_name
           FROM theme_members tm
           JOIN themes t ON t.theme_code = tm.theme_code AND t.is_active = 1
           JOIN listed_info li ON li.code = tm.code
          WHERE tm.confidence >= ?`,
        [conf],
      );
      return rows;
    },

    async universe() {
      const rows = await query<{ code: string }>("SELECT code FROM listed_info");
      return rows.map((r) => r.code);
    },

    async group(groupCode: string) {
      const [name, rows] = await Promise.all([
        query<{ theme_name: string }>(
          "SELECT theme_name FROM themes WHERE theme_code = ? LIMIT 1",
          [groupCode],
        ),
        query<{ code: string }>(
          `SELECT tm.code FROM theme_members tm
             JOIN listed_info li ON li.code = tm.code
            WHERE tm.theme_code = ? AND tm.confidence >= ?
            ORDER BY tm.code`,
          [groupCode, conf],
        ),
      ]);
      return { name: name[0]?.theme_name ?? null, codes: rows.map((r) => r.code) };
    },
  };
}
