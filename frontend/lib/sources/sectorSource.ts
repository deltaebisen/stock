import "server-only";
import { query } from "../db";
import type { GroupSource } from "../grouping";

export type SectorLevel = "sector33" | "sector17";

/**
 * 東証の業種 (33業種 / 17業種) をグループとして扱う GroupSource。
 * 1 銘柄 1 業種なので members() に同じ code は 1 回しか出てこない。
 */
export function sectorSource(level: SectorLevel): GroupSource {
  const codeCol = `${level}_code`;
  const nameCol = `${level}_name`;

  return {
    // 既存のキャッシュキー ("returns:sector33" 等) と同じ文字列になるようにしている
    key: level,

    async members() {
      const rows = await query<{ code: string; group_code: string; group_name: string | null }>(
        `SELECT code, ${codeCol} AS group_code, ${nameCol} AS group_name FROM listed_info
          WHERE ${codeCol} IS NOT NULL`,
      );
      return rows.map((r) => ({
        code: r.code,
        group_code: r.group_code,
        group_name: r.group_name ?? r.group_code,
      }));
    },

    async universe() {
      // 市場平均の母集団は「業種が付いている全銘柄」= 従来の集計と同じ
      const rows = await query<{ code: string }>(
        `SELECT code FROM listed_info WHERE ${codeCol} IS NOT NULL`,
      );
      return rows.map((r) => r.code);
    },

    async group(groupCode: string) {
      const rows = await query<{ code: string; group_name: string | null }>(
        `SELECT code, ${nameCol} AS group_name FROM listed_info WHERE ${codeCol} = ? ORDER BY code`,
        [groupCode],
      );
      return { name: rows[0]?.group_name ?? null, codes: rows.map((r) => r.code) };
    },
  };
}
